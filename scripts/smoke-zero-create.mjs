#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: This Framework checkout, `git`, `tar`, and temporary HOME / Installed / source roots.
 * [OUTPUT]: PASS/FAIL lines for on-device zero-create: `sdk new --dev`, development-only state,
 *           no-restart loading, restore/rollback refusals, release from the installed work tree,
 *           same-version officialization with a development backup, and the WebUI contract.
 * [POS]: scripts/smoke-zero-create.mjs in termux-os-framework.
 * [PROTOCOL]: Isolated: temporary directories, a private port, no device, no network. No global
 *             Git identity exists in the temporary HOME, so the placeholder identity path is tested.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8967;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'zero-create-smoke-token';
const ID = 'github.termux-os.app.zero-probe';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-create-'));
const home = path.join(work, 'home');
const installed = path.join(work, 'packages');
const sourceRoot = path.join(work, 'sources');
fs.mkdirSync(home, { recursive: true });
const pkgRoot = path.join(installed, ID);
const W = path.join(pkgRoot, 'versions', '0.1.0');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
  if (!ok) failures += 1;
};
// No GIT_AUTHOR_* here: the SDK must make commits possible on its own.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  HOME: home, PACKAGES_INSTALLED_DIR: installed, TERMUX_OS_SOURCE_ROOT: sourceRoot, TERMUX_OS_DEV_ROOT: path.join(work, 'legacy'),
  TERMUX_OS_FRAMEWORK_URL: BASE, FRAMEWORK_BASE_URL: BASE, TERMUX_OS_TOKEN: TOKEN,
  PORT_REGISTRY_PATH: path.join(work, 'ports.v1.json'), GIT_CONFIG_NOSYSTEM: '1',
};
const git = (...args) => execFileSync('git', ['-C', W, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const lastJson = (out) => {
  try { return JSON.parse(out); } catch { /* fall through */ }
  const start = out.lastIndexOf('\n{');
  for (const i of [start + 1, out.indexOf('{')]) { try { return JSON.parse(out.slice(i)); } catch { /* next */ } }
  return null;
};
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? work, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', json: lastJson(r.stdout ?? '') };
};
const sdk = (...args) => run(path.join(ROOT, 'sdk/termux-os-sdk'), args);
const pm = (...args) => run(process.execPath, [path.join(ROOT, 'scripts/package-manager.mjs'), ...args], { cwd: ROOT });

let server = null;
let cookie = null;
async function startServer() {
  server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT, env: { ...env, HOST: '127.0.0.1', PORT: String(PORT), FRAMEWORK_ADMIN_TOKEN: TOKEN, FRAMEWORK_ADMIN_PASSWORD: TOKEN,
      BROWSER_SESSION_PATH: path.join(work, 'sessions.json') },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 150; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await sleep(100); }
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
}
async function stopServer() { if (server) { server.kill(); await sleep(400); server = null; } }
const api = async (p, { method = 'GET', body, session = false } = {}) => {
  const headers = session ? { Cookie: cookie } : { Authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const textBody = await r.text();
  let data = null; try { data = JSON.parse(textBody); } catch { /* HTML */ }
  return { status: r.status, data, text: textBody };
};
const pmState = () => pm('state', ID).json;

try {
  await startServer();
  const pidsBefore = (await api('/api/stage/services')).data?.services?.map((s) => `${s.id}:${s.process?.pid}`).join(',');

  // Z1: one command creates a runnable Development Package in the Installed Root.
  const t0 = Date.now();
  const created = sdk('new', '--type', 'app', '--template', 'web', '--dev', '--id', ID, '--name', 'Zero Probe', '--json');
  const createMs = Date.now() - t0;
  const c = created.json;
  check('Z1 new --dev succeeds', created.status === 0 && c?.ok === true, created.out + created.err);
  check('Z1 output names state, work tree, Git, and URL', c?.state === 'development' && c?.development_only === true
    && c?.worktree === W && c?.git?.branch === 'main' && /^[0-9a-f]{40}$/.test(c?.git?.head ?? '')
    && c?.package_url === `${BASE}/packages/${ID}/` && c?.loaded === true, JSON.stringify(c));
  check('Z1 no second source tree under the source root', !fs.existsSync(path.join(sourceRoot, ID)));
  check('Z1 no Release archive was built or saved', !fs.existsSync(path.join(pkgRoot, 'archive'))
    && !fs.existsSync(path.join(ROOT, 'dist', 'releases', ID)));
  const active = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'active.json'), 'utf8'));
  check('Z1 active.json is honest: development source, no archive SHA, no hashes', active.source_kind === 'development'
    && active.archive_sha256 === null && Object.keys(active.hashes).length === 0);
  check(`Z1 created quickly (${createMs} ms)`, createMs < 15000);

  // Z2: Git bootstrap and identity.
  check('Z2 .git on main with one baseline commit', git('branch', '--show-current') === 'main'
    && git('rev-list', '--count', 'HEAD') === '1' && git('rev-parse', 'HEAD') === c?.git?.head);
  check('Z2 placeholder identity is repo-local', c?.git?.identity === 'placeholder'
    && git('config', '--local', 'user.email') === 'termux-os-local@localhost.invalid');
  check('Z2 identity is in no tracked file',
    spawnSync('git', ['-C', W, 'grep', '-q', 'localhost.invalid'], { env }).status === 1);
  check('Z2 .sdk metadata lives beside versions/, not in the work tree', fs.existsSync(path.join(pkgRoot, '.sdk', 'project.v1.json'))
    && !fs.existsSync(path.join(W, '.sdk')));

  // Z3: development-only state.
  let s = pmState();
  check('Z3 state development, development-only, no official baseline', s?.state === 'development' && s?.provenance === 'development'
    && s?.development?.base_released_head === null && s?.development?.base_release_sha256 === null
    && s?.git?.head_relation === 'no-official-baseline' && s?.protection_required === true, JSON.stringify(s?.git));
  check('Z3 summary says there is no official baseline', String(s?.summary).includes('no official baseline'));
  const again = pm('activate-development', ID);
  check('Z3 activating again → development_already_active', again.status === 1 && again.json?.code === 'development_already_active');

  // Z4/Z5: loaded without a Framework restart; dev start; page served.
  const loaded = await api(`/api/packages/${ID}`);
  check('Z4 loaded into the running Framework (no restart)', loaded.data?.package?.status === 'loaded', loaded.text);
  const pidsAfter = (await api('/api/stage/services')).data?.services?.map((s2) => `${s2.id}:${s2.process?.pid}`).join(',');
  check('Z4 no other service was restarted', pidsBefore === pidsAfter);
  const page = await api(`/packages/${ID}/`, { session: true });
  check('Z4 Web App page is served', page.status === 200 && page.text.includes('Zero Probe'));
  const started = sdk('dev', 'start', ID, '--json');
  check('Z5 dev start watches the one work tree', started.status === 0 && started.json?.version_dir === W && started.json?.worktree === W, started.out);
  const seq0 = (await api(`/api/dev/packages/${ID}/events`)).data?.seq;
  const idx = path.join(W, 'web', 'index.html');
  const tmp = `${idx}.tmp`; fs.writeFileSync(tmp, fs.readFileSync(idx, 'utf8').replace('Hello', 'Hello edit')); fs.renameSync(tmp, idx);
  let seen = false;
  for (let i = 0; i < 60 && !seen; i += 1) { await sleep(100); seen = (await api(`/api/dev/packages/${ID}/events`)).data?.seq > seq0; }
  check('Z5 an atomic web edit reaches the page sequence', seen);

  // Z9: branch and commit work immediately.
  git('switch', '-q', '-c', 'dev/foo');
  const cB = spawnSync('git', ['-C', W, 'commit', '-q', '-am', 'B'], { env, encoding: 'utf8' });
  check('Z9 git commit works with no identity setup', cB.status === 0, cB.stderr);
  fs.appendFileSync(path.join(W, 'web', 'style.css'), '#greeting { font-weight: 600; }\n');
  git('commit', '-q', '-am', 'C');
  const C = git('rev-parse', 'HEAD');
  s = pmState();
  check('Z9 two local commits are reported against the local baseline', s?.git?.commits_ahead === 2 && s?.state === 'development');

  // Z6: Framework restart keeps the development-only Package.
  await api(`/api/dev/packages/${ID}/stop`, { method: 'POST' });
  await stopServer(); await startServer();
  const reloaded = await api(`/api/packages/${ID}`);
  check('Z6 reloaded after a Framework restart', reloaded.data?.package?.status === 'loaded');
  check('Z6 provenance and HEAD unchanged after restart', pmState()?.provenance === 'development' && git('rev-parse', 'HEAD') === C
    && git('branch', '--show-current') === 'dev/foo');

  // Z7/Z8: nothing official to go back to.
  const restore = pm('restore', ID);
  check('Z7 restore → official_baseline_unavailable, work tree intact', restore.status === 1
    && restore.json?.code === 'official_baseline_unavailable' && git('rev-parse', 'HEAD') === C, restore.out);
  const rollback = pm('rollback', ID);
  check('Z8 rollback → no_previous_release', rollback.status === 1 && rollback.json?.code === 'no_previous_release', rollback.out);

  // Z15: the admin inventory and WebUI carry the Development view.
  const inv = (await api('/api/admin/package-manager', { session: true })).data?.packages?.find((p) => p.id === ID);
  check('Z15 inventory reports development-only with the work tree', inv?.install_safety?.state === 'development'
    && inv?.development_only === true && inv?.restorable === false && inv?.worktree === W && inv?.install_safety?.dirty === true, JSON.stringify(inv?.install_safety));
  const ui = (await api('/admin/admin-controls.js', { session: true })).text + (await api('/admin/app-core.js', { session: true })).text;
  check('Z15 WebUI: state badge, explicit activation, restore/backup/uninstall choices',
    ['package-state', '/development/activate', 'restore-backup', "'restore'", 'preserve_development', 'force_discard',
      'function chooseAction', '/development/backups'].every((token) => ui.includes(token))
    && !ui.includes('dev sync 推送'));

  // Z10/Z11: release from the installed work tree.
  const rel = sdk('release', ID, '--json');
  const tar = rel.json?.release;
  check('Z10 release builds from the installed work tree', rel.status === 0 && Boolean(tar) && fs.existsSync(tar), rel.out.slice(-600) + rel.err);
  const asset = tar ? JSON.parse(fs.readFileSync(`${tar}.asset.json`, 'utf8')) : {};
  check('Z10 artifact HEAD is the accepted HEAD C on dev/foo', asset.head === C && asset.branch === 'dev/foo', JSON.stringify(asset));
  const listing = tar ? execFileSync('tar', ['-tzf', tar], { encoding: 'utf8' }) : '';
  check('Z11 artifact carries .git but no development metadata, config, or .sdk', listing.includes('/.git/')
    && !/\.development|\/config\/|\/\.sdk\//.test(listing));
  const extracted = path.join(work, 'extract'); fs.mkdirSync(extracted);
  if (tar) execFileSync('tar', ['-xzf', tar, '-C', extracted]);
  const gitConfig = fs.readFileSync(path.join(extracted, ID, '.git', 'config'), 'utf8');
  check('Z11 artifact .git/config has no placeholder identity', !gitConfig.includes('localhost.invalid'));

  // Z12–Z14: same-version first officialization through the SDK.
  const inst = sdk('install', tar, '--json');
  check('Z12 sdk install of the release just built from HEAD succeeds', inst.status === 0, inst.out.slice(-800) + inst.err);
  check('Z13 the install was protected automatically', inst.out.includes('--preserve-development') || inst.out.includes('development history is backed up'));
  const backups = pm('development-backups', ID).json?.backups ?? [];
  const pre = backups.find((b) => b.reason === 'update');
  check('Z13 development backup holds dev/foo, main and B/C lineage', Boolean(pre?.refs?.some((r) => r.ref === 'refs/heads/dev/foo' && r.commit === C)
    && pre?.refs?.some((r) => r.ref === 'refs/heads/main')), JSON.stringify(backups.map((b) => b.reason)));
  s = pmState();
  const after = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'active.json'), 'utf8'));
  check('Z14 official, released_head = HEAD = C, archive recorded', s?.state === 'official' && s?.provenance === 'official'
    && s?.git?.head === C && s?.released_head === C && after.archive_sha256 && !after.source_kind && after.previous_version === null
    && fs.existsSync(path.join(pkgRoot, 'archive', '0.1.0@generic.tar.gz')), JSON.stringify({ state: s?.state, after }));
  check('Z14 no second source tree exists', !fs.existsSync(path.join(sourceRoot, ID)));

  // Second cycle: official → development again; an arbitrary archive is not auto-protected.
  const act = await api(`/api/dev/packages/${ID}/development/activate`, { method: 'POST' });
  check('official Package re-enters Development explicitly', act.data?.ok === true && pmState()?.state === 'development');
  git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid');
  fs.appendFileSync(path.join(W, 'web', 'style.css'), '/* D */\n');
  git('commit', '-q', '-am', 'D');
  const stale = sdk('install', tar, '--json');
  check('an archive not built from the current HEAD is not auto-protected (refused)', stale.status !== 0
    && (stale.out + stale.err).includes('development_backup_required'), stale.out.slice(-400));
  const off = pm('restore', ID, '--preserve-development');
  check('verified restore returns it to official', off.status === 0 && pmState()?.state === 'official', off.out + off.err);
} catch (error) {
  failures += 1;
  console.log(`FAIL unexpected error — ${error?.stack ?? error}`);
} finally {
  await stopServer();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'dist', 'releases', ID), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.runtime', 'dev', 'gen', ID), { recursive: true, force: true });
}
console.log(failures ? `zero create: ${failures} FAIL` : 'zero create: ALL PASS');
process.exit(failures ? 1 : 0);
