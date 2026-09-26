#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: This Framework checkout, `git`, `tar`, and temporary Source, Installed, and HOME roots.
 * [OUTPUT]: PASS/FAIL lines for Development provenance, local-history detection, and the
 *           restore / update / prune / uninstall protections with development backup round trips.
 * [POS]: scripts/smoke-dev-provenance.mjs in termux-os-framework.
 * [PROTOCOL]: Isolated: temporary directories, a private port, no device, no network. Releases are
 *             built with the real shallow-Git builder so the installed tree has the real shape.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8968;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'provenance-smoke-token';
const ID = 'github.termux-os.app.provenance-probe';
const PLAIN = 'github.termux-os.app.provenance-plain';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-provenance-'));
const home = path.join(work, 'home');
const installed = path.join(work, 'packages');
const source = path.join(work, 'source', ID);
const dist = path.join(work, 'dist');
fs.mkdirSync(home, { recursive: true });
const pkgRoot = path.join(installed, ID);
const V = (version) => path.join(pkgRoot, 'versions', version);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  if (!ok) failures += 1;
};
const env = {
  ...process.env, HOME: home, PACKAGES_INSTALLED_DIR: installed, FRAMEWORK_BASE_URL: BASE, TERMUX_OS_TOKEN: TOKEN,
  PORT_REGISTRY_PATH: path.join(work, 'ports.v1.json'), TERMUX_OS_DEV_ROOT: path.join(work, 'legacy'),
  SHARED_ASSET_STORE: path.join(work, 'models'), ASSETS_REGISTRY_DIR: path.join(work, 'assets'),
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
/** package-manager with stdout JSON (last JSON object) and the exit status. */
function pm(...args) {
  const r = spawnSync(process.execPath, ['scripts/package-manager.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  const out = r.stdout ?? '';
  let json = null;
  try { json = JSON.parse(out); } catch {
    for (const line of out.split('\n').reverse()) { if (line.trim().startsWith('{')) { try { json = JSON.parse(line); break; } catch { /* next */ } } }
  }
  return { status: r.status, json, out, err: r.stderr ?? '' };
}
const state = (id = ID) => pm('state', id).json;

function writeSource(version) {
  fs.mkdirSync(path.join(source, 'web'), { recursive: true });
  fs.writeFileSync(path.join(source, 'termux-os.package.json'), `${JSON.stringify({
    schema: 'termux-os.package.v1', id: ID, name: 'Provenance probe', version, types: ['app'],
    entrypoints: { backend: 'package.mjs', webui: 'web/index.html' }, components: {}, capabilities: {},
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(source, 'package.mjs'), `export async function register(context) {
  context.routes.register('GET', '/version', async (req, res, { json }) => json(res, 200, { version: '${version}' }));
}\n`);
  fs.writeFileSync(path.join(source, 'web', 'index.html'), `<!doctype html><p>${version}</p>\n`);
}
function release(version) {
  writeSource(version);
  if (!fs.existsSync(path.join(source, '.git'))) git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '-A'); git(source, 'commit', '-qm', `v${version}`);
  execFileSync('bash', [path.join(ROOT, 'scripts/build-package-asset.sh'), '--source', source, '--out-dir', dist], { env, stdio: 'ignore' });
  return path.join(dist, `${ID}-${version}.tar.gz`);
}
const commit = (dir, message) => { fs.appendFileSync(path.join(dir, 'web', 'index.html'), `<!-- ${message} -->\n`); git(dir, 'commit', '-qam', message); return git(dir, 'rev-parse', 'HEAD'); };

let server = null;
async function startServer() {
  server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT, env: { ...env, HOST: '127.0.0.1', PORT: String(PORT), FRAMEWORK_ADMIN_TOKEN: TOKEN, FRAMEWORK_ADMIN_PASSWORD: TOKEN,
      BROWSER_SESSION_PATH: path.join(work, 'sessions.json') },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 150; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ } await sleep(100); }
  throw new Error('Framework did not start');
}
async function stopServer() { if (server) { server.kill(); await sleep(400); server = null; } }
const api = async (p, method = 'GET') => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, data: await r.json().catch(() => null) };
};

try {
  const tar010 = release('0.1.0');
  const A = git(source, 'rev-parse', 'HEAD');
  let r = pm('install', tar010);
  check('install official 0.1.0 (shallow Git Release)', r.status === 0, r.err);
  let s = state();
  check('fresh install is official with no local history', s.state === 'official' && s.provenance === 'official'
    && s.local_history_present === false && s.git.released_head === A, JSON.stringify(s));
  git(V('0.1.0'), 'config', 'user.name', 'T'); git(V('0.1.0'), 'config', 'user.email', 't@example.invalid');

  // Git-only modification without activation is "modified", never "official", never "development".
  commit(V('0.1.0'), 'B-unactivated');
  s = state();
  check('P3 HEAD=B clean without activation → modified + local history', s.state === 'modified' && s.local_history_present === true
    && s.provenance === 'official', JSON.stringify(s?.state));
  git(V('0.1.0'), 'reset', '-q', '--hard', A);
  s = state();
  check('back at the release with nothing else → official again (no provenance was set)', s.state === 'official');

  // P1/P2: explicit, sticky activation.
  r = pm('activate-development', ID);
  check('P1 activate-development succeeds', r.status === 0 && r.json?.development?.base_released_head === A, r.out + r.err);
  check('P1 provenance persists beside versions/, outside the work tree',
    fs.existsSync(path.join(pkgRoot, '.development', 'provenance.v1.json')) && git(V('0.1.0'), 'status', '--porcelain') === '');
  r = pm('activate-development', ID);
  check('activating twice → development_already_active', r.status === 1 && r.json?.code === 'development_already_active', r.out);
  s = state();
  check('P2 HEAD=A clean + development provenance → development', s.state === 'development' && s.reason === 'development_provenance'
    && s.local_history_present === false, JSON.stringify(s?.state));
  check('state, reason and summary agree', s.summary.startsWith('development') && s.reason === 'development_provenance');

  // P15/P16: watcher and Framework restart never touch provenance.
  await startServer();
  let d = await api(`/api/dev/packages/${ID}/development`);
  check('HTTP development status reports the same provenance', d.data?.provenance === 'development' && d.data?.state === 'development', JSON.stringify(d.data));
  check('dev status fields do not contradict each other', d.data?.state_summary?.startsWith('development') && d.data?.state_reason === 'development_provenance');
  await fetch(`${BASE}/api/dev/packages`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ package_id: ID }) });
  await api(`/api/dev/packages/${ID}/stop`, 'POST');
  check('P15 dev start/stop keeps development', state().state === 'development');
  await stopServer(); await startServer();
  check('P16 Framework restart keeps development', (await api(`/api/dev/packages/${ID}/development`)).data?.provenance === 'development');
  await stopServer();
  git(V('0.1.0'), 'switch', '-qc', 'other'); git(V('0.1.0'), 'switch', '-q', 'main'); git(V('0.1.0'), 'branch', '-D', 'other');
  git(V('0.1.0'), 'reset', '-q', '--hard', A);
  check('git switch / reset --hard to the release keeps development', state().state === 'development');
  const lineage = pm('activate-development', 'github.termux-os.app.not-installed');
  check('activation of a Package that is not installed is refused', lineage.status === 1 && lineage.json?.code === 'not_installed', lineage.out);

  // P4/P5: side branch and stash while HEAD=A.
  git(V('0.1.0'), 'switch', '-qc', 'dev/test');
  const B = commit(V('0.1.0'), 'B'); const C = commit(V('0.1.0'), 'C');
  git(V('0.1.0'), 'switch', '-q', 'main');
  s = state();
  check('P4 side branch B/C while HEAD=A → local history', s.local_history_present === true && s.git.head_relation === 'at-release'
    && s.git.local_refs.some((x) => x.ref === 'refs/heads/dev/test' && x.commits === 2), JSON.stringify(s?.git?.local_refs));
  fs.appendFileSync(path.join(V('0.1.0'), 'web', 'index.html'), 'stashed edit\n');
  git(V('0.1.0'), 'stash', '-q');
  s = state();
  check('P5 stash while HEAD=A clean → local history', s.local_history_present === true && s.git.stash_count === 1 && s.git.worktree === 'clean');

  // P6/P9/P11: default refusals with stable codes.
  r = pm('restore', ID);
  check('P6 restore is refused by default', r.status === 1 && r.json?.code === 'development_backup_required', r.out + r.err);
  const tar011 = release('0.1.1');
  r = pm('install', tar011);
  check('P9 update is refused by the side branch/stash', r.status === 1 && r.json?.code === 'development_backup_required', r.out + r.err);
  check('P14 a refused update keeps development provenance', state().provenance === 'development');
  r = pm('uninstall', ID);
  check('P11 uninstall is refused by default', r.status === 1 && ['development_backup_required', 'local_history_present'].includes(r.json?.code), r.out);

  // P7/P13: preserve backup + verified restore makes it official.
  r = pm('restore', ID, '--preserve-development');
  check('P7 restore --preserve-development succeeds', r.status === 0, r.out + r.err);
  let backups = pm('development-backups', ID).json?.backups ?? [];
  const restoreBackup = backups.find((b) => b.reason === 'restore');
  check('P7 backup metadata records refs, stash, HEAD and SHA', Boolean(restoreBackup?.sha256 && restoreBackup.head === A
    && restoreBackup.refs.some((x) => x.ref === 'refs/heads/dev/test' && x.commit === C) && restoreBackup.stash_count === 1
    && restoreBackup.provenance === 'development'), JSON.stringify(restoreBackup));
  s = state();
  check('P13 verified restore → official, HEAD=A, no local history', s.state === 'official' && s.provenance === 'official'
    && s.git.head === A && s.local_history_present === false, JSON.stringify(s?.state));
  check('P13 restore removed the development branch from the live tree', !git(V('0.1.0'), 'branch', '--list', 'dev/test'));

  // P8: backup restore brings branches, commits and stash back.
  r = pm('restore-development-backup', ID, restoreBackup.name);
  check('P8 restore-development-backup succeeds', r.status === 0, r.out + r.err);
  check('P8 branch dev/test is back at C', git(V('0.1.0'), 'rev-parse', 'refs/heads/dev/test') === C);
  check('P8 commit B is back', git(V('0.1.0'), 'cat-file', '-t', B) === 'commit');
  check('P8 stash is back', git(V('0.1.0'), 'stash', 'list').split('\n').filter(Boolean).length === 1);
  check('P8 restored tree is development again', state().provenance === 'development');
  fs.writeFileSync(`${restoreBackup.archive}`, fs.readFileSync(restoreBackup.archive).subarray(0, 64));
  r = pm('restore-development-backup', ID, restoreBackup.name);
  check('a corrupted backup is refused with backup_sha_mismatch', r.status === 1 && r.json?.code === 'backup_sha_mismatch', r.out);
  r = pm('restore-development-backup', ID, 'no-such-backup');
  check('an unknown backup is refused with backup_not_found', r.status === 1 && r.json?.code === 'backup_not_found', r.out);

  // P14: a successful update with preserve clears provenance; P10: prune archives local history.
  r = pm('install', tar011, `${tar011}.sha256`, '--preserve-development');
  check('P14 update --preserve-development succeeds', r.status === 0, r.out + r.err);
  s = state();
  check('P14 verified install of a new Release → official', s.state === 'official' && s.provenance === 'official', JSON.stringify(s?.state));
  check('previous 0.1.0 still holds dev/test after the update', git(V('0.1.0'), 'rev-parse', 'refs/heads/dev/test') === C);
  const tar012 = release('0.1.2');
  const before = (pm('development-backups', ID).json?.backups ?? []).length;
  r = pm('install', tar012);
  check('install 0.1.2 prunes 0.1.0', r.status === 0 && !fs.existsSync(V('0.1.0')), r.out + r.err);
  backups = pm('development-backups', ID).json?.backups ?? [];
  const pruned = backups.find((b) => b.reason === 'prune' && b.version === '0.1.0');
  check('P10 prune archived the local history of 0.1.0 first', backups.length === before + 1
    && pruned?.refs?.some((x) => x.ref === 'refs/heads/dev/test' && x.commit === C), JSON.stringify(pruned));

  // P11/P12: uninstall with local history in an inactive version, then force discard.
  fs.mkdirSync(path.join(pkgRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'config', 'keep.json'), '{"keep":true}\n');
  git(V('0.1.1'), 'config', 'user.name', 'T'); git(V('0.1.1'), 'config', 'user.email', 't@example.invalid');
  git(V('0.1.1'), 'switch', '-qc', 'old-work'); commit(V('0.1.1'), 'old work'); git(V('0.1.1'), 'switch', '-q', '-');
  r = pm('uninstall', ID);
  check('P11 uninstall is refused by history in the previous version', r.status === 1 && r.json?.code === 'local_history_present', r.out);
  r = pm('uninstall', ID, '--force-discard');
  check('P12 uninstall --force-discard succeeds', r.status === 0, r.out + r.err);
  check('P12 uninstall keeps config/ and removes code', fs.existsSync(path.join(pkgRoot, 'config', 'keep.json'))
    && !fs.existsSync(path.join(pkgRoot, 'versions')) && !fs.existsSync(path.join(pkgRoot, 'active.json')));
  check('a config-only directory is not listed as an installed Package', !pm('list').out.includes(ID));
  check('development backups survive uninstall', (pm('development-backups', ID).json?.backups ?? []).length === backups.length);

  // Lineage unavailable: a Release without Git cannot be developed in place.
  const plainSrc = path.join(work, 'source', PLAIN);
  fs.mkdirSync(path.join(plainSrc, 'web'), { recursive: true });
  for (const f of ['README.md', 'NOTICE.md', 'LICENSE', 'AGENTS.md']) fs.writeFileSync(path.join(plainSrc, f), 'x\n');
  fs.writeFileSync(path.join(plainSrc, 'termux-os.package.json'), JSON.stringify({ schema: 'termux-os.package.v1', id: PLAIN,
    name: 'Plain', version: '1.0.0', types: ['app'], entrypoints: { backend: 'package.mjs', webui: 'web/index.html' }, components: {}, capabilities: {} }));
  fs.writeFileSync(path.join(plainSrc, 'package.mjs'), 'export async function register() {}\n');
  fs.writeFileSync(path.join(plainSrc, 'web', 'index.html'), '<p>plain</p>\n');
  const packed = spawnSync(process.execPath, ['scripts/package-manager.mjs', 'pack', PLAIN, '--source', plainSrc], { cwd: ROOT, env, encoding: 'utf8' });
  const plainTar = path.join(ROOT, 'dist', 'releases', PLAIN, '1.0.0', `${PLAIN}-1.0.0.tar.gz`);
  r = pm('install', plainTar);
  check('a Release without Git installs', packed.status === 0 && r.status === 0, packed.stderr + r.err);
  s = state(PLAIN);
  check('its state is unknown, not official', s.state === 'unknown' && s.provenance === 'official', JSON.stringify(s?.state));
  r = pm('activate-development', PLAIN);
  check('activation without lineage → development_lineage_unavailable', r.status === 1 && r.json?.code === 'development_lineage_unavailable', r.out);
} catch (error) {
  failures += 1;
  console.log(`FAIL unexpected error — ${error?.stack ?? error}`);
} finally {
  await stopServer();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'dist', 'releases', PLAIN), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.runtime', 'dev', 'gen', ID), { recursive: true, force: true });
}
console.log(failures ? `dev provenance: ${failures} FAIL` : 'dev provenance: ALL PASS');
process.exit(failures ? 1 : 0);
