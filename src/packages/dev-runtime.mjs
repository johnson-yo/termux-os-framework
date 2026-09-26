/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The single Installed Package worktree, the Package loader, and the Stage supervisor.
 * [OUTPUT]: Dev watcher, transactional reload, runtime-generation ownership, and reconcile APIs;
 *           `reloadPackageRuntime` is the one code-reload path shared with Package restart.
 * [POS]: src/packages/dev-runtime.mjs in termux-os-framework.
 * [PROTOCOL]: A generation is only a module-cache copy. It is never a Package
 *             instance. One Package ID has one active worktree, one loaded
 *             Package record, and at most one generation owner.
 *             Change detection is pathname truth: `fs.watch` is only a latency hint and a
 *             periodic tree reconciliation is the correctness backstop, because a recursive
 *             watch silently stops reporting a file once an editor or `git checkout` replaces its
 *             inode. A reload never tears down the last-good runtime before the candidate has
 *             proved it can load; a failed candidate is discarded and the old runtime keeps serving.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadSinglePackage, unregisterPackage, _getRecord, preflightPackageCandidate,
} from './loader.mjs';
import { hashWorkspace, WORKSPACE_HASH_SKIP as SKIP } from './workspace-hash.mjs';
import { reconcilePackage } from './reconcile.mjs';
import { activateDevelopment, listDevelopmentBackups } from './provenance.mjs';
import { acquirePackageLock } from './operation-lock.mjs';
import * as stage from '../stage/manager.mjs';

export { hashWorkspace };

/** Stable machine-readable code for any candidate reload failure. */
export const DEV_RELOAD_FAILED = 'dev_reload_failed';

// A change batch is settled once the tree has been quiet this long; a `git switch` touching a
// hundred files therefore becomes one reload, not a hundred.
const QUIET_MS = 250;
// The reconciliation interval bounds how late a change that `fs.watch` missed can be noticed.
const scanIntervalMs = () => Math.max(250, Number(process.env.TERMUX_OS_DEV_SCAN_MS) || 2000);

let CFG = null;
let runtimeSession = null;
const watchers = new Map();
const runtimeGenerations = new Map();
const queues = new Map();
// Last reload outcome per Package, kept independently of the watcher so a manual reload or a
// Package restart reports the same fields.
const reloadResults = new Map();

const genRoot = () => path.join(CFG.frameworkRoot, '.runtime', 'dev', 'gen');
const ownerRoot = () => path.join(CFG.frameworkRoot, '.runtime', 'dev', 'owners');
const ownerKey = (id) => encodeURIComponent(String(id)).replaceAll('%', '_');
const loadOptions = () => ({
  frameworkVersion: CFG.frameworkVersion, config: CFG.config, configPath: CFG.configPath,
  saveConfig: CFG.saveConfig, log: CFG.log,
});

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
    if (entry.name !== keep) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) removeGeneration(target);
      // Older builds placed a Package's configuration beside the generation. It is not live.
      else fs.rmSync(target, { force: true });
    }
  }
}

const reloadFields = (id) => {
  const r = reloadResults.get(id);
  return {
    last_reload: r?.at ?? null,
    last_reload_result: r?.result ?? null,
    last_reload_error: r?.error ?? null,
    last_reload_failed_at: r?.failed_at ?? null,
  };
};

const publicWatcher = (w) => ({
  package_id: w.id, watching: true, version_dir: w.dir,
  runtime_generation: w.gen?.id ?? runtimeGenerations.get(w.id)?.generation ?? null,
  watch_mode: w.watch_mode ?? null, started_at: w.started_at, seq: w.seq, session: w.session,
  ...reloadFields(w.id),
  last_error: reloadResults.get(w.id)?.error?.message ?? null,
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
  for (const w of watchers.values()) stopWatcher(w);
  watchers.clear();
  runtimeGenerations.clear();
  reloadResults.clear();
  // A Framework restart stops the old service owners before this module is
  // initialized. Any generation left behind is therefore stale, never a
  // reason to start another Package.
  fs.rmSync(genRoot(), { recursive: true, force: true });
  fs.rmSync(ownerRoot(), { recursive: true, force: true });
}

export const listDevWatchers = () => [...watchers.values()].map(publicWatcher);
export const isDevWatched = (id) => watchers.has(id);

/**
 * What an open dev page polls. A Package that is not being watched still answers, with
 * `watching: false`, so a page opened during a dev session keeps a low-frequency poll through
 * `dev stop` and resumes live reload on `dev start` instead of reloading itself into a page
 * without the marker.
 */
export const devEvents = (id) => {
  const w = watchers.get(id);
  const record = _getRecord(id);
  if (!w) return record ? { watching: false, seq: 0, session: null, status: record.status ?? 'unknown' } : null;
  return {
    watching: true, seq: w.seq, session: w.session,
    status: record?.status ?? 'unknown', error: record?.error ?? null,
    ...reloadFields(id),
  };
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
  // state, state_reason, and state_summary come from the one shared snapshot so they cannot disagree.
  const ps = reconcile.package_state;
  return {
    ok: true, package_id: id, version_dir: reconcile.active.path,
    state: reconcile.state, state_reason: reconcile.state_reason, state_summary: reconcile.state_summary,
    provenance: ps?.provenance ?? null, development: ps?.development ?? null,
    local_history_present: ps?.local_history_present ?? null, protection_required: ps?.protection_required ?? null,
    git: ps?.git ?? null,
    changes: ps?.git?.changes ?? [], ignored_paths: ps?.git?.ignored ?? [],
    watching: Boolean(w), watch_mode: w?.watch_mode ?? null, seq: w?.seq ?? 0,
    runtime_generation: reconcile.runtime_generation,
    runtime_owner: reconcile.runtime_owner,
    ...reloadFields(id),
    services: record?.registered?.services ?? [], status: record?.status ?? 'unknown',
    error: record?.error ?? null, reconcile,
  };
}

function assertSafe(id, { allowConflict = false } = {}) {
  // Hot path (every reload): identity and conflicts only, no ref/stash scan.
  const result = reconcilePackage(id, { frameworkRoot: CFG.frameworkRoot, runtime: runtimeFor(id), history: false });
  if (!result.active) return { ok: false, error: 'not_installed', reconcile: result };
  if (result.conflict && !allowConflict) return {
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

async function startServices(record, wanted) {
  const started = [];
  for (const sid of wanted) {
    if (!record?.registered?.services?.includes(sid)) continue;
    const result = await stage.startService(sid);
    if (result?.ok !== false) started.push(sid);
  }
  return started;
}

async function devWatchStartImpl(id) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized' };
  const safe = assertSafe(id);
  if (!safe.ok) return safe;
  if (watchers.has(id)) return { ok: true, already: true, watcher: publicWatcher(watchers.get(id)), state: devStatus(id) };
  const w = {
    id, dir: safe.reconcile.active.path, started_at: new Date().toISOString(),
    session: crypto.randomBytes(6).toString('hex'), seq: 1,
    pending: new Set(), snapshot: null,
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

function recordReload(id, result, error = null) {
  const at = new Date().toISOString();
  const previous = reloadResults.get(id);
  reloadResults.set(id, {
    at, result, error,
    failed_at: error ? at : (previous?.failed_at ?? null),
  });
}

/**
 * Load a candidate generation of the active worktree, switching to it only once it has loaded.
 *
 *   last-good (serving) ─ preflight candidate (manifest + module import, no global effects)
 *        │                    ├─ fail → discard candidate; last-good untouched
 *        │                    └─ ok → stop services → swap registration → register()
 *        │                               ├─ ok → start services, drop old generation
 *        │                               └─ fail → re-register last-good, restart its services
 */
async function reloadImpl(id, { reason = 'manual', allowConflict = false } = {}) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized' };
  const safe = assertSafe(id, { allowConflict });
  if (!safe.ok) return safe;
  const dir = safe.reconcile.active.path;
  const packageRoot = safe.reconcile.active.root;
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

  const failed = (stage, message, extra = {}) => {
    const error = { code: DEV_RELOAD_FAILED, stage, message };
    recordReload(id, 'failed', error);
    CFG.log(`dev reload ${id} (${reason}): candidate failed at ${stage} — ${message}`);
    const live = _getRecord(id);
    return {
      ok: false, status: 'failed', error: DEV_RELOAD_FAILED, error_code: DEV_RELOAD_FAILED,
      error_stage: stage, detail: message, runtime_status: live?.status ?? 'absent',
      runtime_generation: runtimeGenerations.get(id)?.generation ?? null, ...extra,
    };
  };

  let generation;
  try { generation = newGeneration(id, dir); }
  catch (error) { return failed('copy', String(error?.message ?? error)); }
  const cacheToken = `${generation.id}`;
  const preflight = await preflightPackageCandidate({ dir: generation.path, expectId: id, cacheToken },
    { frameworkVersion: CFG.frameworkVersion });
  if (!preflight.ok) {
    removeGeneration(generation.path);
    return failed(preflight.stage, preflight.error);
  }

  const oldRecord = _getRecord(id);
  const lastGood = oldRecord?.status === 'loaded' ? {
    dir: oldRecord.dir, packageRoot: oldRecord.packageRoot ?? packageRoot, install: oldRecord.install,
    manifest: oldRecord.manifest, codeToken: oldRecord.codeToken ?? null,
    owner: runtimeGenerations.get(id) ?? null,
  } : null;
  const wasRunning = await stopPackageServices(id);
  await unregisterPackage(id);
  const owner = writeOwner(id, generation);
  let record = null;
  let loadError = null;
  try {
    record = await loadSinglePackage({
      dir: generation.path, expectId: id, source: 'installed', install, cacheBust: cacheToken, packageRoot,
      manifest: preflight.manifest,
    }, loadOptions());
    const current = runtimeGenerations.get(id);
    if (!current || current.generation !== owner.generation || current.session !== runtimeSession) {
      throw Object.assign(new Error('stale dev generation lost ownership'), { code: 'stale_generation_owner' });
    }
  } catch (error) { loadError = String(error?.message ?? error); }

  if (!loadError && record?.status === 'loaded') {
    // Web assets read the active worktree; backend imports use this generation.
    record.webRoot = path.join(dir, path.dirname(record.manifest.entrypoints.webui));
    // The new generation is serving from here on; report it before services take their time.
    recordReload(id, 'loaded');
    const restarted = await startServices(record, wasRunning);
    if (lastGood && isGeneration(lastGood.dir) && lastGood.dir !== generation.path) removeGeneration(lastGood.dir);
    sweepGenerations(id, generation.id);
    const w = watchers.get(id);
    if (w) { w.gen = generation; w.seq += 1; }
    CFG.log(`dev reload ${id} (${reason}): loaded ${generation.id}`);
    return {
      ok: true, status: 'loaded', error: null, runtime_generation: generation.id,
      restarted_services: restarted, reconcile: devStatus(id).reconcile,
    };
  }

  // register() or a later load step failed after the swap. Put the last-good runtime back.
  const message = loadError ?? record?.error ?? 'candidate did not load';
  // Nothing was serving before this attempt: the failed candidate record is the honest state.
  if (!lastGood) return failed('register', message, { rolled_back: false });
  await unregisterPackage(id);
  clearOwner(id, owner.generation);
  removeGeneration(generation.path);
  const restored = await loadSinglePackage({
    dir: lastGood.dir, expectId: id, source: 'installed', install: lastGood.install,
    packageRoot: lastGood.packageRoot, manifest: lastGood.manifest, cacheBust: lastGood.codeToken ?? false,
  }, loadOptions()).catch((error) => ({ status: 'failed', error: String(error?.message ?? error) }));
  if (restored?.status === 'loaded') {
    restored.webRoot = path.join(dir, path.dirname(restored.manifest.entrypoints.webui));
    if (lastGood.owner) writeOwner(id, { id: lastGood.owner.generation, path: lastGood.owner.path });
    await startServices(restored, wasRunning);
  }
  return failed('register', message, { rolled_back: restored?.status === 'loaded' });
}

/** Reload the one Package record; operation requests for an ID are queued. */
export function reloadPackageRuntime(id, options = {}) {
  return serialized(id, async () => {
    const lock = await acquirePackageLock(id, { root: process.env.PACKAGES_INSTALLED_DIR });
    try { return await reloadImpl(id, options); }
    finally { lock.release(); }
  });
}

/**
 * Explicit Development activation (HTTP). Provenance only: no Git file, branch, workspace, or
 * watcher is touched; the watcher and provenance stay independent.
 */
export function activatePackageDevelopment(id) {
  return serialized(id, async () => {
    const lock = await acquirePackageLock(id, { root: process.env.PACKAGES_INSTALLED_DIR });
    try {
      const current = reconcilePackage(id, { frameworkRoot: CFG.frameworkRoot });
      if (!current.active) return { ok: false, error: 'not_installed', error_code: 'not_installed' };
      let active = null;
      try { active = JSON.parse(fs.readFileSync(current.active.active_json, 'utf8')); } catch { /* validated by reconcile */ }
      const result = activateDevelopment({
        id, versionRoot: current.active.path, packageRoot: current.active.root, active, conflicts: current.conflicts,
      });
      if (!result.ok) return { ok: false, error: result.code, error_code: result.code, detail: result.detail ?? null, fix: result.fix ?? null };
      return { ok: true, package_id: id, development: result.development, state: devStatus(id) };
    } finally { lock.release(); }
  });
}

export const developmentBackups = (id) => listDevelopmentBackups(id);

/** Dev reload: the same transaction, refused while the Package identity needs reconcile. */
export const devReload = (id, options = {}) => reloadPackageRuntime(id, { ...options, allowConflict: false });

// ============================================================
// Watcher: fs.watch is a hint; the tree snapshot is the truth
// ============================================================

/**
 * Pathname-level signature of the worktree. The inode is part of it so an atomic replace that
 * happens to keep size and mtime (same second, same length) is still a change.
 */
export function snapshotTree(dir) {
  const map = new Map();
  const walk = (current, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name === '.git') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, next);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const st = fs.lstatSync(full);
          map.set(next, `${entry.isFile() ? 'f' : 'l'}:${st.size}:${st.mtimeMs}:${st.ino}`);
        } catch { /* The file changed during the scan; the next scan settles it. */ }
      }
    }
  };
  walk(dir, '');
  return map;
}

export function diffTrees(before, after) {
  const changed = [];
  for (const [rel, sig] of after) if (before.get(rel) !== sig) changed.push(rel);
  for (const rel of before.keys()) if (!after.has(rel)) changed.push(rel);
  return changed;
}

function webDirOf(id) {
  const record = _getRecord(id);
  return record?.manifest?.entrypoints?.webui ? path.dirname(record.manifest.entrypoints.webui) : 'web';
}

export function classifyChange(relPath, webDir = 'web') {
  if (!relPath) return 'backend';
  const top = relPath.split(/[\\/]/)[0];
  if (SKIP.has(top) || top === '.git') return null;
  const prefix = webDir === '.' ? '' : `${webDir}/`;
  return prefix && relPath.replaceAll('\\', '/').startsWith(prefix) ? 'web' : 'backend';
}

function scan(w) {
  if (!watchers.has(w.id) || watchers.get(w.id) !== w) return;
  const now = snapshotTree(w.dir);
  const changes = diffTrees(w.snapshot, now);
  w.snapshot = now;
  if (!changes.length) return;
  for (const rel of changes) w.pending.add(rel);
  clearTimeout(w.quietTimer);
  w.quietTimer = setTimeout(() => settle(w), QUIET_MS);
}

async function settle(w) {
  if (watchers.get(w.id) !== w) return;
  if (w.flushing) { w.quietTimer = setTimeout(() => settle(w), QUIET_MS); return; }
  // One last look: a batch that is still being written must not be cut in half.
  const now = snapshotTree(w.dir);
  const late = diffTrees(w.snapshot, now);
  w.snapshot = now;
  if (late.length) {
    for (const rel of late) w.pending.add(rel);
    w.quietTimer = setTimeout(() => settle(w), QUIET_MS);
    return;
  }
  if (!w.pending.size) return;
  const batch = [...w.pending];
  w.pending.clear();
  w.flushing = true;
  try {
    const webDir = webDirOf(w.id);
    const kinds = new Set(batch.map((rel) => classifyChange(rel, webDir)).filter(Boolean));
    // Replaced inodes are exactly what a recursive watch loses; re-arm on the current tree.
    armFsWatch(w);
    if (kinds.has('backend')) {
      const first = batch.find((rel) => classifyChange(rel, webDir) === 'backend');
      const result = await devReload(w.id, { reason: `file change: ${first}${batch.length > 1 ? ` (+${batch.length - 1})` : ''}` })
        .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      // A successful reload already advanced seq. A failed candidate keeps the last-good backend,
      // but web files in the same batch are live on disk and the page should show them.
      if (!result?.ok && kinds.has('web') && watchers.get(w.id) === w) w.seq += 1;
    } else if (kinds.has('web')) {
      w.seq += 1;
    }
  } finally {
    w.flushing = false;
  }
}

function armFsWatch(w) {
  if (w.fsWatcher) { try { w.fsWatcher.close(); } catch { /* Already closed. */ } w.fsWatcher = null; }
  if (w.watch_mode === 'scan') return;
  try {
    const watcher = fs.watch(w.dir, { recursive: true }, (_event, filename) => {
      const rel = filename ? String(filename) : null;
      if (rel && classifyChange(rel) === null) return; // `.git` and skipped trees never trigger work.
      clearTimeout(w.hintTimer);
      w.hintTimer = setTimeout(() => scan(w), 50);
    });
    watcher.on('error', () => { try { watcher.close(); } catch { /* Already closed. */ } });
    w.fsWatcher = watcher;
  } catch {
    w.watch_mode = 'scan';
  }
}

function startWatcher(w) {
  w.snapshot = snapshotTree(w.dir);
  w.watch_mode = process.env.TERMUX_OS_DEV_POLL === '1' ? 'scan' : 'fs-watch+scan';
  armFsWatch(w);
  w.scanTimer = setInterval(() => scan(w), scanIntervalMs());
  w.scanTimer.unref?.();
}

function stopWatcher(w) {
  clearTimeout(w.quietTimer);
  clearTimeout(w.hintTimer);
  if (w.scanTimer) { clearInterval(w.scanTimer); w.scanTimer = null; }
  if (w.fsWatcher) { try { w.fsWatcher.close(); } catch { /* Already closed. */ } w.fsWatcher = null; }
}
