/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An Installed Root, Framework runtime root, and a Package ID.
 * [OUTPUT]: One identity/reconcile snapshot for that Package.
 * [POS]: src/packages/reconcile.mjs in termux-os-framework.
 * [PROTOCOL]: ACTIVE is the only Package worktree. Previous/archive data,
 *             runtime generations, and legacy source directories are reported
 *             explicitly and never selected as runtime truth.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedRoot, ACTIVE_FILENAME, ACTIVE_SCHEMA } from './installed-root.mjs';
import { packageGitIdentity, packageGitState, GIT_STATE } from './git-state.mjs';

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const samePath = (a, b) => Boolean(a && b && real(a) === real(b));
const targetOf = (active) => active?.active_target ?? 'generic';
const archiveKey = (version, target) => `${version}@${target ?? 'generic'}`;
const safeKey = (id) => encodeURIComponent(String(id)).replaceAll('%', '_');
const legacyDirectoryNames = (id) => {
  const names = new Set([id]);
  const shortName = String(id).split('.').at(-1);
  if (shortName) names.add(shortName);
  return [...names];
};

export function legacyWorkspaceCandidates(id, {
  home = os.homedir(),
  legacyRoot = process.env.TERMUX_OS_DEV_ROOT || null,
} = {}) {
  const roots = [
    legacyRoot,
    path.join(home, 'termux-os-dev', 'packages'),
  ].filter(Boolean).map((root) => path.resolve(root));
  const seen = new Set();
  const names = new Set(legacyDirectoryNames(id));
  const out = [];
  for (const root of roots) {
    // Legacy workspaces historically used the package slug (for example
    // termux-speech) while the installed root is keyed by the full id. Check
    // both names, then inspect manifests so custom names are still reported.
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const manifest = readJson(path.join(root, entry.name, 'termux-os.package.json'));
          if (manifest?.id === id) names.add(entry.name);
        }
      }
    } catch { /* A missing legacy root is a clean result. */ }
    for (const name of names) {
      const dir = path.join(root, name);
      if (seen.has(dir) || !fs.existsSync(dir)) continue;
      seen.add(dir);
      const manifest = readJson(path.join(dir, 'termux-os.package.json'));
      out.push({
        path: dir,
        exists: true,
        manifest_id: manifest?.id ?? null,
        version: manifest?.version ?? null,
        git: packageGitIdentity(dir),
        valid_identity: manifest?.id === id,
      });
    }
  }
  return out;
}

function installedRecords(root, requestedId) {
  const records = [];
  const errors = [];
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')); }
  catch { return { records, errors }; }
  for (const entry of names) {
    const dir = path.join(root, entry.name);
    const activePath = path.join(dir, ACTIVE_FILENAME);
    if (!fs.existsSync(activePath)) {
      if (fs.existsSync(path.join(dir, 'versions'))) errors.push({ path: dir, error: 'active_json_missing' });
      continue;
    }
    const active = readJson(activePath);
    if (!active) { errors.push({ path: activePath, error: 'active_json_unreadable' }); continue; }
    const id = active.id ?? entry.name;
    if (requestedId && id !== requestedId && entry.name !== requestedId) continue;
    const valid = active.schema === ACTIVE_SCHEMA && active.id === entry.name
      && typeof active.active_version === 'string' && active.active_version.length > 0;
    const versionDir = valid ? path.join(dir, 'versions', active.active_version) : null;
    records.push({
      root_name: entry.name,
      id,
      dir,
      active_path: activePath,
      active,
      valid,
      version_dir: versionDir,
      version_exists: Boolean(versionDir && fs.existsSync(versionDir)),
    });
    if (!valid) errors.push({ path: activePath, error: 'active_json_identity_invalid' });
  }
  return { records, errors };
}

function archiveInventory(pkgDir) {
  const dir = path.join(pkgDir, 'archive');
  const out = [];
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      const meta = name.endsWith('.json') ? readJson(file) : null;
      out.push({ name, path: file, kind: name.endsWith('.json') ? 'metadata' : 'archive',
        version: meta?.version ?? name.split('@')[0] ?? null,
        target: meta?.target ?? null, sha256: meta?.sha256 ?? null });
    }
  } catch { /* No archive is a valid non-restorable installation. */ }
  return out;
}

function generationInventory(frameworkRoot, id) {
  const root = path.join(frameworkRoot, '.runtime', 'dev', 'gen', id);
  const generations = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) generations.push({ id: entry.name, path: path.join(root, entry.name) });
    }
  } catch { /* No generations is the normal release state. */ }
  const owner = readJson(path.join(frameworkRoot, '.runtime', 'dev', 'owners', `${safeKey(id)}.json`));
  const current = owner?.package_id === id && generations.find((g) => g.id === owner.generation) ? owner.generation : null;
  return {
    owner: owner?.package_id === id ? {
      package_id: id,
      generation: owner.generation ?? null,
      pid: owner.pid ?? null,
      session: owner.session ?? null,
      started_at: owner.started_at ?? null,
    } : null,
    current,
    all: generations,
    stale: generations.filter((g) => g.id !== current),
  };
}

function activeReleaseHead(pkgDir, active) {
  if (!active?.active_version) return null;
  const meta = readJson(path.join(pkgDir, 'archive', `${archiveKey(active.active_version, targetOf(active))}.json`));
  return meta?.head ?? null;
}

export function reconcilePackage(id, {
  root = installedRoot(),
  frameworkRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
  legacy = true,
  legacyRoot = process.env.TERMUX_OS_DEV_ROOT || null,
  runtime = null,
  watcher = null,
  ownedServices = [],
} = {}) {
  const scanned = installedRecords(root, id);
  const matching = scanned.records.filter((record) => record.id === id || record.root_name === id);
  const valid = matching.filter((record) => record.valid && record.version_exists);
  const duplicate = matching.length > 1 ? matching.map((record) => ({
    root_name: record.root_name, path: record.version_dir, valid: record.valid, version_exists: record.version_exists,
  })) : [];
  const record = valid.length === 1 ? valid[0] : null;
  const active = record ? record.active : null;
  const versionDir = record?.version_dir ?? null;
  const git = versionDir ? packageGitState(versionDir) : {
    state: GIT_STATE.UNKNOWN, changes: [], ignored: [], error: null, reason: 'active_worktree_missing',
  };
  const identity = versionDir ? packageGitIdentity(versionDir) : packageGitIdentity(null);
  const releasedHead = record ? activeReleaseHead(record.dir, active) : null;
  const headDiverged = Boolean(releasedHead && identity.head && releasedHead !== identity.head);
  const legacyWorkspaces = legacy ? legacyWorkspaceCandidates(id, { legacyRoot }).filter((item) => !samePath(item.path, versionDir)) : [];
  const generations = generationInventory(frameworkRoot, id);
  const runtimeInfo = runtime ?? {
    generation: generations.current,
    owner: generations.owner,
  };
  const conflicts = [
    ...scanned.errors.map((error) => ({ kind: 'installed_root_error', ...error })),
    ...(duplicate.length ? [{ kind: 'duplicate_active_worktrees', items: duplicate }] : []),
    ...legacyWorkspaces.map((workspace) => ({ kind: 'legacy_workspace', ...workspace })),
  ];
  const state = conflicts.length ? 'conflicted'
    : !record ? GIT_STATE.UNKNOWN
      : git.state === GIT_STATE.RELEASE && headDiverged ? GIT_STATE.DEV : git.state;
  const previousVersion = active?.previous_version ?? null;
  const previousTarget = active?.previous_target ?? 'generic';
  const previousPath = record && previousVersion ? path.join(record.dir, 'versions', previousVersion) : null;
  const previousArchive = record && previousVersion
    ? path.join(record.dir, 'archive', `${archiveKey(previousVersion, previousTarget)}.tar.gz`) : null;
  const previousArchiveMeta = record && previousVersion
    ? readJson(path.join(record.dir, 'archive', `${archiveKey(previousVersion, previousTarget)}.json`)) : null;
  const previousArchiveSha = active?.hashes?.[archiveKey(previousVersion, previousTarget)]
    ?? previousArchiveMeta?.sha256 ?? null;
  const rollback = previousVersion ? {
    version: previousVersion,
    target: previousTarget,
    archive: previousArchive,
    archive_sha256: previousArchiveSha,
    restorable: Boolean(previousArchive && fs.existsSync(previousArchive)),
  } : null;
  return {
    schema: 'termux-os.package-reconcile.v1',
    package_id: id,
    state,
    safe_for_write: conflicts.length === 0 && Boolean(record),
    conflict: conflicts.length > 0,
    conflicts,
    active: record ? {
      path: versionDir,
      root: record.dir,
      version: active.active_version,
      target: targetOf(active),
      active_json: record.active_path,
      exists: record.version_exists,
      released_head: releasedHead,
      archive_sha256: active.archive_sha256 ?? null,
      installed_at: active.installed_at ?? null,
    } : null,
    git: { ...git, ...identity, dirty: git.state === GIT_STATE.DEV,
      released_head: releasedHead, head_diverged: headDiverged },
    previous: previousVersion ? {
      version: previousVersion,
      target: previousTarget,
      path: previousPath,
      exists: Boolean(previousPath && fs.existsSync(previousPath)),
      archive: previousArchive,
      archive_sha256: previousArchiveSha,
      restorable: Boolean(previousArchive && fs.existsSync(previousArchive)),
    } : null,
    rollback,
    archive: record ? {
      dir: path.join(record.dir, 'archive'),
      entries: archiveInventory(record.dir),
      active_sha256: active.archive_sha256 ?? null,
    } : null,
    runtime_generation: runtimeInfo?.generation ?? generations.current,
    runtime_owner: runtimeInfo?.owner ?? generations.owner,
    runtime_generations: generations.all,
    stale_generations: generations.stale,
    watcher: watcher ?? null,
    owned_services: ownedServices,
    legacy_workspace: legacyWorkspaces[0] ?? null,
    legacy_workspaces: legacyWorkspaces,
  };
}

export function packageHasConflict(id, options = {}) {
  return reconcilePackage(id, options).conflict;
}

if (process.argv[1] && process.argv[1].endsWith('reconcile.mjs') && process.argv.includes('--self-test')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-reconcile-'));
  const root = path.join(tmp, 'packages');
  const framework = path.join(tmp, 'framework');
  const activeDir = path.join(root, 'example.id', 'versions', '1.0.0');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(path.join(activeDir, 'termux-os.package.json'), JSON.stringify({ id: 'example.id', version: '1.0.0' }));
  fs.mkdirSync(path.join(root, 'example.id', 'versions', '0.9.0'), { recursive: true });
  fs.mkdirSync(path.join(root, 'example.id', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'example.id', 'active.json'), JSON.stringify({
    schema: ACTIVE_SCHEMA, id: 'example.id', active_version: '1.0.0', previous_version: '0.9.0',
    archive_sha256: 'a'.repeat(64),
  }));
  const release = reconcilePackage('example.id', { root, frameworkRoot: framework, legacy: false });
  const checks = [
    ['one active worktree', release.active?.version === '1.0.0' && release.previous?.version === '0.9.0'],
    ['previous is rollback material', release.previous?.restorable === false && release.runtime_generations.length === 0],
  ];
  const legacyDir = path.join(tmp, 'legacy', 'example-package');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'termux-os.package.json'), JSON.stringify({ id: 'example.id', version: '0.8.0' }));
  const withLegacy = reconcilePackage('example.id', { root, frameworkRoot: framework, legacyRoot: path.dirname(legacyDir) });
  checks.push(['legacy is reported as conflict', withLegacy.state === 'conflicted' && withLegacy.legacy_workspace?.path === legacyDir]);
  console.log(checks.map(([name, ok]) => `${ok ? 'ok' : 'FAIL'} ${name}`).join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}
