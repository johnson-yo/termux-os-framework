/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The single Installed Package worktree, the Package loader, and the Stage supervisor.
 * [OUTPUT]: Dev watcher, reload, runtime-generation ownership, and reconcile APIs.
 * [POS]: src/packages/dev-runtime.mjs in termux-os-framework.
 * [PROTOCOL]: A generation is only a module-cache copy. It is never a Package
 *             instance. One Package ID has one active worktree, one loaded
 *             Package record, and at most one generation owner.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadSinglePackage, unregisterPackage, _getRecord } from './loader.mjs';
import { hashWorkspace, WORKSPACE_HASH_SKIP as SKIP } from './workspace-hash.mjs';
import { packageGitState, describeGitState } from './git-state.mjs';
import { reconcilePackage } from './reconcile.mjs';
import { acquirePackageLock } from './operation-lock.mjs';
import * as stage from '../stage/manager.mjs';

export { hashWorkspace };

let CFG = null;
let runtimeSession = null;
const watchers = new Map();
const runtimeGenerations = new Map();
const queues = new Map();

const genRoot = () => path.join(CFG.frameworkRoot, '.runtime', 'dev', 'gen');
const ownerRoot = () => path.join(CFG.frameworkRoot, '.runtime', 'dev', 'owners');
const ownerKey = (id) => encodeURIComponent(String(id)).replaceAll('%', '_');

async function serialized(id, fn) {
  const previous = queues.get(id) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  queues.set(id, current);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (queues.get(id) === current) queues.delete(id);
  }
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function isGeneration(dir) {
  return Boolean(dir && CFG && path.resolve(dir).startsWith(`${path.resolve(genRoot())}${path.sep}`));
}

function newGeneration(id, dir) {
  const generation = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dst = path.join(genRoot(), id, generation);
  copyTree(dir, dst);
  return { id: generation, path: dst };
}

function writeOwner(id, generation) {
  const owner = {
    schema: 'termux-os.dev-runtime-owner.v1', package_id: id,
    generation: generation.id, pid: process.pid, session: runtimeSession,
    started_at: new Date().toISOString(),
  };
  fs.mkdirSync(ownerRoot(), { recursive: true });
  const file = path.join(ownerRoot(), `${ownerKey(id)}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(owner, null, 2)}\n`);
  fs.renameSync(tmp, file);
  runtimeGenerations.set(id, { ...owner, path: generation.path });
  return owner;
}

function clearOwner(id, generation = null) {
  const current = runtimeGenerations.get(id);
  if (generation && current?.generation && current.generation !== generation) return;
  runtimeGenerations.delete(id);
  try { fs.rmSync(path.join(ownerRoot(), `${ownerKey(id)}.json`), { force: true }); } catch { /* Best effort. */ }
}

function removeGeneration(dir) {
  if (!isGeneration(dir)) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* A later reconcile can report it as stale. */ }
}

function sweepGenerations(id, keep) {
  const root = path.join(genRoot(), id);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== keep) removeGeneration(path.join(root, entry.name));
  }
}

const publicWatcher = (w) => ({
  package_id: w.id, watching: true, version_dir: w.dir,
  runtime_generation: w.gen?.id ?? null,
  watch_mode: w.watch_mode ?? null, started_at: w.started_at, seq: w.seq,
  last_reload: w.last_reload ?? null, last_error: w.last_error ?? null,
});

function runtimeFor(id) {
  const current = runtimeGenerations.get(id);
  return current ? { generation: current.generation, owner: {
    package_id: id, generation: current.generation, pid: current.pid, session: current.session,
    started_at: current.started_at,
  } } : null;
}

export function initDevRuntime(cfg) {
  CFG = cfg;
  runtimeSession = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  watchers.clear();
  runtimeGenerations.clear();
  // A Framework restart stops the old service owners before this module is
  // initialized. Any generation left behind is therefore stale, never a
  // reason to start another Package.
  fs.rmSync(genRoot(), { recursive: true, force: true });
  fs.rmSync(ownerRoot(), { recursive: true, force: true });
}

export const listDevWatchers = () => [...watchers.values()].map(publicWatcher);
export const isDevWatched = (id) => watchers.has(id);

export const devEvents = (id) => {
  const w = watchers.get(id);
  if (!w) return null;
  const record = _getRecord(id);
  return { seq: w.seq, status: record?.status ?? 'unknown', error: record?.error ?? null };
};

export function devStatus(id) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized', package_id: id };
  const w = watchers.get(id);
  const record = _getRecord(id);
  const runtime = runtimeFor(id);
  const reconcile = reconcilePackage(id, {
    frameworkRoot: CFG.frameworkRoot,
    runtime,
    watcher: w ? publicWatcher(w) : null,
    ownedServices: record?.registered?.services ?? [],
  });
  if (!reconcile.active) return { ok: false, error: 'not_installed', package_id: id, reconcile };
  const git = packageGitState(reconcile.active.path);
  return {
    ok: true, package_id: id, version_dir: reconcile.active.path,
    state: reconcile.state, state_reason: git.reason, state_summary: reconcile.state === 'conflicted'
      ? 'conflicted (reconcile required)' : describeGitState(git),
    changes: git.changes, ignored_paths: git.ignored,
    watching: Boolean(w), watch_mode: w?.watch_mode ?? null, seq: w?.seq ?? 0,
    runtime_generation: reconcile.runtime_generation,
    runtime_owner: reconcile.runtime_owner,
    last_reload: w?.last_reload ?? null,
    services: record?.registered?.services ?? [], status: record?.status ?? 'unknown',
    error: record?.error ?? null, reconcile,
  };
}

function assertSafe(id) {
  const result = reconcilePackage(id, { frameworkRoot: CFG.frameworkRoot, runtime: runtimeFor(id) });
  if (!result.active) return { ok: false, error: 'not_installed', reconcile: result };
  if (result.conflict) return {
    ok: false, error: 'package_reconcile_required', reconcile: result,
    fix: 'Resolve the reported duplicate, stale, or legacy identity before starting or reloading dev runtime.',
  };
  return { ok: true, reconcile: result };
}

async function stopPackageServices(id) {
  const record = _getRecord(id);
  if (!record) return [];
  const live = await stage.listServices();
  const wasRunning = [];
  for (const sid of record.registered.services) {
    const service = live.find((item) => item.id === sid);
    if (service?.process?.state === 'running') wasRunning.push(sid);
    await stage.stopService(sid, { preserveDesired: true });
  }
  return wasRunning;
}

async function devWatchStartImpl(id) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized' };
  const safe = assertSafe(id);
  if (!safe.ok) return safe;
  if (watchers.has(id)) return { ok: true, already: true, watcher: publicWatcher(watchers.get(id)), state: devStatus(id) };
  const w = {
    id, dir: safe.reconcile.active.path, started_at: new Date().toISOString(),
    source_hash: hashWorkspace(safe.reconcile.active.path), seq: 1,
    last_error: null, last_reload: null,
  };
  const loaded = _getRecord(id);
  const current = runtimeGenerations.get(id);
  if (current) w.gen = { id: current.generation, path: current.path };
  else if (loaded && isGeneration(loaded.dir)) w.gen = { id: path.basename(loaded.dir), path: loaded.dir };
  watchers.set(id, w);
  startWatcher(w);
  CFG.log(`dev watch ${id}: ${w.dir} (${w.watch_mode})`);
  return { ok: true, watcher: publicWatcher(w), state: devStatus(id) };
}

/** Start watching the single active worktree. */
export function devWatchStart(id) { return serialized(id, () => devWatchStartImpl(id)); }

function devWatchStopImpl(id) {
  const w = watchers.get(id);
  if (!w) return { ok: false, error: 'not_watching', state: devStatus(id) };
  stopWatcher(w);
  watchers.delete(id);
  // The loaded generation belongs to the running Package, not to the watcher.
  // Stopping a watcher must never delete a live service cwd.
  CFG?.log(`dev watch stopped ${id}`);
  return { ok: true, package_id: id, state: devStatus(id) };
}

/** Stop watching without changing Package state or removing its runtime owner. */
export function devWatchStop(id) { return serialized(id, async () => devWatchStopImpl(id)); }

async function devReloadImpl(id, { reason = 'manual' } = {}) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized' };
  const safe = assertSafe(id);
  if (!safe.ok) return safe;
  const dir = safe.reconcile.active.path;
  const w = watchers.get(id);
  const oldRecord = _getRecord(id);
  let install = null;
  try {
    const active = JSON.parse(fs.readFileSync(safe.reconcile.active.active_json, 'utf8'));
    install = {
      version: active.active_version,
      previous_version: active.previous_version ?? null,
      archive_sha256: active.archive_sha256 ?? null,
      installed_at: active.installed_at ?? null,
    };
  } catch { /* The active identity is already validated by reconcile; keep reload diagnostics primary. */ }
  const oldGeneration = oldRecord && isGeneration(oldRecord.dir) ? oldRecord.dir : null;
  const wasRunning = await stopPackageServices(id);
  await unregisterPackage(id);
  const generation = newGeneration(id, dir);
  const owner = writeOwner(id, generation);
  let record = null;
  try {
    record = await loadSinglePackage(
      { dir: generation.path, expectId: id, source: 'installed', install, cacheBust: true }, CFG);
    const current = runtimeGenerations.get(id);
    if (!current || current.generation !== owner.generation || current.session !== runtimeSession) {
      throw Object.assign(new Error('stale dev generation lost ownership'), { code: 'stale_generation_owner' });
    }
    if (record?.status === 'loaded') {
      // Web assets read the active worktree; backend imports use this generation.
      record.webRoot = path.join(dir, path.dirname(record.manifest.entrypoints.webui));
      for (const sid of wasRunning) {
        if (record.registered.services.includes(sid)) await stage.startService(sid);
      }
    }
  } catch (error) {
    await unregisterPackage(id);
    clearOwner(id, owner.generation);
    removeGeneration(generation.path);
    CFG.log(`dev reload ${id} (${reason}): failed — ${String(error?.message ?? error)}`);
    return { ok: false, status: 'failed', error: String(error?.message ?? error), error_code: error?.code ?? null };
  }
  if (oldGeneration && oldGeneration !== generation.path) removeGeneration(oldGeneration);
  sweepGenerations(id, generation.id);
  const nextWatcher = watchers.get(id);
  if (nextWatcher) {
    nextWatcher.gen = generation;
    nextWatcher.source_hash = hashWorkspace(dir);
    nextWatcher.seq += 1;
    nextWatcher.last_error = record?.error ?? null;
    nextWatcher.last_reload = new Date().toISOString();
  }
  CFG.log(`dev reload ${id} (${reason}): ${record?.status ?? 'failed'}${record?.error ? ` — ${record.error}` : ''}`);
  return {
    ok: record?.status === 'loaded', status: record?.status ?? 'failed',
    error: record?.error ?? null, runtime_generation: generation.id,
    reconcile: devStatus(id).reconcile,
  };
}

/** Reload the one Package record; operation requests for an ID are queued. */
export function devReload(id, options = {}) {
  return serialized(id, async () => {
    const lock = await acquirePackageLock(id, { root: process.env.PACKAGES_INSTALLED_DIR });
    try { return await devReloadImpl(id, options); }
    finally { lock.release(); }
  });
}

function classifyChange(w, relPath) {
  if (!relPath) return 'backend';
  const top = relPath.split(path.sep)[0];
  if (SKIP.has(top) || top === '.git') return null;
  const record = _getRecord(w.id);
  const webDir = record?.manifest ? path.dirname(record.manifest.entrypoints.webui) : 'web';
  return relPath.startsWith(`${webDir}${path.sep}`) || relPath.startsWith(`${webDir}/`) ? 'web' : 'backend';
}

function onFsChange(w, relPath) {
  const kind = classifyChange(w, relPath);
  if (!kind) return;
  if (kind === 'web') { w.seq += 1; return; }
  clearTimeout(w.debounce);
  w.debounce = setTimeout(() => {
    devReload(w.id, { reason: `file change: ${relPath}` }).catch((error) => CFG?.log(`dev reload ${w.id}: ${error.message}`));
  }, 600);
}

function snapshotMtimes(dir) {
  const map = new Map();
  const walk = (current, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name === '.git') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), next);
      else if (entry.isFile()) {
        try { map.set(next, fs.statSync(path.join(current, entry.name)).mtimeMs); } catch { /* File changed during the scan. */ }
      }
    }
  };
  walk(dir, '');
  return map;
}

function startWatcher(w) {
  try {
    if (process.env.TERMUX_OS_DEV_POLL === '1') throw new Error('forced polling');
    w.watcher = fs.watch(w.dir, { recursive: true }, (_event, filename) => onFsChange(w, filename ?? null));
    w.watch_mode = 'fs-watch';
  } catch {
    w.mtimes = snapshotMtimes(w.dir);
    w.pollTimer = setInterval(() => {
      const now = snapshotMtimes(w.dir);
      for (const [rel, time] of now) if (w.mtimes.get(rel) !== time) onFsChange(w, rel);
      for (const rel of w.mtimes.keys()) if (!now.has(rel)) onFsChange(w, rel);
      w.mtimes = now;
    }, 2000);
    w.watch_mode = 'poll';
  }
}

function stopWatcher(w) {
  clearTimeout(w.debounce);
  if (w.watcher) { try { w.watcher.close(); } catch { /* Already closed. */ } w.watcher = null; }
  if (w.pollTimer) { clearInterval(w.pollTimer); w.pollTimer = null; }
}
