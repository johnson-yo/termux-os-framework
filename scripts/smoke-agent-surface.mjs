#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: This Framework checkout, `git`, `tar`, and temporary HOME / PREFIX / Installed roots.
 * [OUTPUT]: PASS/FAIL lines for the Agent control surface: `termux-os-sdk` on PATH, pure --json
 *           stdout, `service`, `restore`, `rollback`, `uninstall`, `dev backup|backups|restore-backup`
 *           and the single `dev status` object — all through the SDK only.
 * [POS]: scripts/smoke-agent-surface.mjs in termux-os-framework.
 * [PROTOCOL]: Isolated: temporary directories, a private port, no device, no network. Every SDK
 *             call here parses stdout with JSON.parse directly; no log-stripping fallback exists.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSdkShim } from '../src/system/sdk-shim.mjs';

process.env.TERMUX_OS_SDK_SHIM = '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8968;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'agent-surface-smoke-token';
const ID = 'github.termux-os.app.agent-probe';
const SERVICE = 'agent-probe-ticker';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-surface-'));
const home = path.join(work, 'home');
const installed = path.join(work, 'packages');
const prefix = path.join(work, 'usr');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
const config = path.join(work, 'conf', 'framework.v1.json');
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'config/defaults/framework.v1.json'), config);
const pkgRoot = path.join(installed, ID);
const W = path.join(pkgRoot, 'versions', '0.1.0');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`);
  if (!ok) failures += 1;
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  HOME: home, PREFIX: prefix, TERMUX_OS_SDK_SHIM: '1', CONFIG: config,
  PACKAGES_INSTALLED_DIR: installed, TERMUX_OS_SOURCE_ROOT: path.join(work, 'sources'), TERMUX_OS_DEV_ROOT: path.join(work, 'legacy'),
  PACKAGE_CONTROL_ROOT: path.join(work, 'control'), FRAMEWORK_UPDATE_ROOT: path.join(work, 'updates'),
  PACKAGE_SETTINGS_PATH: path.join(work, 'package-settings.v1.json'), PORT_REGISTRY_PATH: path.join(work, 'ports.v1.json'),
  STAGE_DESIRED_PATH: path.join(work, 'stage.v1.json'), BROWSER_SESSION_PATH: path.join(work, 'sessions.json'),
  TERMUX_OS_FRAMEWORK_URL: BASE, FRAMEWORK_BASE_URL: BASE, TERMUX_OS_TOKEN: TOKEN, GIT_CONFIG_NOSYSTEM: '1',
};
const git = (...args) => execFileSync('git', ['-C', W, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** Every --json call: stdout must be exactly one JSON document, nothing else. */
const pure = [];
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: work, env, encoding: 'utf8', timeout: 300000 });
  let json = null;
  let parsed = false;
  try { json = JSON.parse(r.stdout ?? ''); parsed = true; } catch { /* reported below */ }
  if (args.includes('--json')) pure.push({ args: args.slice(0, 2).join(' '), parsed, status: r.status, head: (r.stdout ?? '').slice(0, 160) });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', json };
};
const sdkPath = path.join(prefix, 'bin', 'termux-os-sdk');
const sdk = (...args) => run(sdkPath, args);

let server = null;
async function startServer() {
  server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT, env: { ...env, HOST: '127.0.0.1', PORT: String(PORT), FRAMEWORK_ADMIN_TOKEN: TOKEN, FRAMEWORK_ADMIN_PASSWORD: TOKEN },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 150; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await sleep(100); }
}
async function stopServer() { if (server) { server.kill(); await sleep(500); server = null; } }
const api = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  try { return await r.json(); } catch { return null; }
};
const status = () => sdk('dev', 'status', ID, '--json').json;
const commit = (file, text, message) => {
  fs.appendFileSync(path.join(W, file), text);
  git('commit', '-q', '-am', message);
  return git('rev-parse', 'HEAD');
};

// I1–I3: every string of the Development / Restore / backup surface is translated, so switching
// language never falls back to Simplified Chinese there.
{
  const source = fs.readFileSync(path.join(ROOT, 'web/admin/admin-controls.js'), 'utf8');
  // From entering Development through the uninstall/rollback dialog (the end of startInstalledAction).
  const from = source.indexOf('async function startPackageDev');
  const region = source.slice(from, source.indexOf('\n}\n', source.indexOf('async function startInstalledAction')));
  const strings = [...new Set([...region.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)].map((m) => m[1]))];
  for (const [code, lang] of [['I1', 'en'], ['I2', 'ja'], ['I3', 'zh-Hant']]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/admin/i18n', `${lang}.json`), 'utf8'));
    const missing = strings.filter((key) => !catalog[key]);
    check(`${code} ${lang}: all ${strings.length} Development/Restore/backup strings translated`, strings.length > 40 && missing.length === 0, missing.join(' | '));
  }
}

try {
  // A1: termux-os-sdk on PATH, created by Framework start, never overwriting a foreign command.
  await startServer();
  let link = null; try { link = fs.readlinkSync(sdkPath); } catch { /* checked below */ }
  check('A1 Framework start installs $PREFIX/bin/termux-os-sdk → <framework>/sdk/termux-os-sdk',
    link === path.join(ROOT, 'sdk', 'termux-os-sdk'), link);
  const help = sdk('help', '--json');
  check('A1 the PATH command runs through the symlink', help.status === 0 && help.json?.help?.includes('termux-os-sdk'), help.err);
  check('A1 access-info reports the command', (await api('/api/access-info'))?.sdk_command?.status === 'installed');
  await stopServer(); await startServer();
  check('A1 a Framework restart keeps it current', (await api('/api/access-info'))?.sdk_command?.status === 'current');
  const moved = ensureSdkShim({ prefix, frameworkRoot: path.join(work, 'other-framework') });
  check('A1 a missing target is skipped, not linked', moved.status === 'skipped' && fs.readlinkSync(sdkPath) === path.join(ROOT, 'sdk', 'termux-os-sdk'));
  const otherRoot = path.join(work, 'fw-b'); fs.mkdirSync(path.join(otherRoot, 'sdk'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'sdk', 'termux-os-sdk'), path.join(otherRoot, 'sdk', 'termux-os-sdk'));
  const retarget = ensureSdkShim({ prefix, frameworkRoot: otherRoot });
  check('A1 update/rollback re-points a Framework-managed link', retarget.status === 'updated' && fs.readlinkSync(sdkPath) === path.join(otherRoot, 'sdk', 'termux-os-sdk'));
  ensureSdkShim({ prefix, frameworkRoot: ROOT });
  const foreignPrefix = path.join(work, 'usr2'); fs.mkdirSync(path.join(foreignPrefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(foreignPrefix, 'bin', 'termux-os-sdk'), '#!/bin/sh\necho mine\n');
  const collision = ensureSdkShim({ prefix: foreignPrefix, frameworkRoot: ROOT });
  check('A1 a foreign file is a collision and stays untouched', collision.status === 'collision'
    && fs.readFileSync(path.join(foreignPrefix, 'bin', 'termux-os-sdk'), 'utf8').includes('echo mine'));
  check('A1 no shell rc file was written', !fs.existsSync(path.join(home, '.bashrc')) && !fs.existsSync(path.join(home, '.profile')));
  check('A1 --json before the Package ID is a flag, not a value', sdk('status', '--json', ID).json?.code !== undefined
    || sdk('status', '--json', ID).json?.package === ID);

  // Zero-create, then add a test Stage service to the Development work tree.
  const created = sdk('new', '--type', 'app', '--template', 'web', '--dev', '--id', ID, '--name', 'Agent Probe', '--json');
  check('setup: zero-create', created.status === 0 && created.json?.worktree === W, created.out + created.err);
  const manifestPath = path.join(W, 'termux-os.package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.components = { ...(manifest.components ?? {}), services: [SERVICE] };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.join(W, 'service'), { recursive: true });
  fs.writeFileSync(path.join(W, 'service', 'ticker.mjs'), "setInterval(() => {}, 1000);\nprocess.on('SIGTERM', () => process.exit(0));\n");
  fs.writeFileSync(path.join(W, 'package.mjs'), `export async function register(context) {
  context.services.register({ id: '${SERVICE}', name: 'Agent Probe Ticker', command: context.nodeExecutable,
    args: ['service/ticker.mjs'], cwd: context.root, stop_timeout_ms: 3000 });
}
`);
  git('add', '-A'); git('commit', '-q', '-m', 'Add a test service');
  const reload = sdk('dev', 'reload', ID, '--json');
  check('setup: dev reload registers the test service', reload.status === 0, reload.out + reload.err);

  // A4–A7: service control through the SDK only.
  const list = sdk('service', 'list', ID, '--json');
  check('A4 service list <package> shows only its services', list.status === 0
    && list.json?.services?.length === 1 && list.json.services[0].id === SERVICE && list.json.services[0].package_id === ID, list.out);
  const all = sdk('service', 'list', '--json');
  check('A4 service list without a filter is the whole Stage list', all.status === 0 && all.json.services.length >= 1);
  const start = sdk('service', 'start', SERVICE, '--json');
  check('A5 service start is post-checked running with a PID', start.status === 0 && start.json?.service?.state === 'running'
    && Number.isInteger(start.json?.service?.pid), start.out + start.err);
  const pid1 = start.json?.service?.pid;
  const restart = sdk('service', 'restart', SERVICE, '--json');
  check('A7 service restart yields a new PID', restart.status === 0 && restart.json?.service?.state === 'running'
    && restart.json.service.pid !== pid1, restart.out);
  const stop = sdk('service', 'stop', SERVICE, '--json');
  check('A6 service stop is post-checked stopped', stop.status === 0 && stop.json?.service?.state !== 'running', stop.out);
  const logs = sdk('service', 'logs', SERVICE, '--json');
  check('A4 service logs returns lines', logs.status === 0 && Array.isArray(logs.json?.lines));
  const missing = sdk('service', 'start', 'no-such-service', '--json');
  check('A4 unknown service → service_not_found', missing.status === 1 && missing.json?.code === 'service_not_found', missing.out);
  sdk('service', 'start', SERVICE, '--json');

  // A14: dev status is the single Agent status.
  sdk('dev', 'start', ID, '--json');
  git('switch', '-q', '-c', 'dev/agent');
  const C1 = commit('web/style.css', '/* agent 1 */\n', 'agent 1');
  let st = status();
  const need = ['package_id', 'state', 'provenance', 'development_only', 'worktree', 'version', 'watching', 'watch_mode',
    'runtime_generation', 'last_reload_result', 'git', 'services', 'rollback', 'restorable', 'development_backups'];
  check('A14 dev status carries every field an Agent needs', need.every((k) => k in (st ?? {})), JSON.stringify(Object.keys(st ?? {})));
  check('A14 dev status: Development work tree and Git lineage', st?.state === 'development' && st?.provenance === 'development'
    && st?.development_only === true && st?.worktree === W && st?.version === '0.1.0'
    && st?.git?.branch === 'dev/agent' && st?.git?.head === C1 && st?.git?.worktree === 'clean'
    && st?.git?.commits_ahead === 2 && st?.git?.stash_count === 0, JSON.stringify(st?.git));
  check('A14 dev status: watcher and reload', st?.watching === true && st?.watch_mode === 'fs-watch+scan'
    && st?.runtime_generation && st?.last_reload_result === 'loaded', JSON.stringify({ w: st?.watching, m: st?.watch_mode, r: st?.last_reload_result }));
  check('A14 dev status: live services with PID', st?.services?.[0]?.id === SERVICE && st.services[0].state === 'running' && st.services[0].pid);
  check('A14 dev status stays compact (raw Framework status only with --verbose)', !('framework' in st) && !('reconcile' in st));

  // A9 (refusal) / A8 (refusal) before any official Release exists.
  const noPrev = sdk('rollback', ID, '--json');
  check('A9 rollback without a previous Release → no_previous_release', noPrev.status === 1 && noPrev.json?.code === 'no_previous_release', noPrev.out);
  const noBase = sdk('restore', ID, '--preserve-development', '--json');
  check('A8 restore of a development-only Package → official_baseline_unavailable', noBase.status === 1
    && noBase.json?.code === 'official_baseline_unavailable' && git('rev-parse', 'HEAD') === C1, noBase.out);

  // A2/A3: test and release JSON purity; release + install make it official (0.1.0).
  const tested = sdk('test', ID, '--json');
  check('A2 test --json stdout parses', tested.json !== null && typeof tested.json.ok === 'boolean', tested.out.slice(0, 300));
  const rel = sdk('release', ID, '--json');
  check('A3 release --json stdout parses and names the artifact', rel.status === 0 && rel.json?.release && fs.existsSync(rel.json.release), rel.out.slice(0, 300) + rel.err.slice(-300));
  check('A3 builder logs went to stderr', rel.err.includes('== doctor ==') || rel.err.length > 0);
  sdk('dev', 'stop', ID, '--json');
  const inst = sdk('install', rel.json?.release ?? 'missing', '--json');
  check('A3 install --json parses; first officialization was protected', inst.status === 0 && inst.json?.ok === true
    && inst.json?.protection === 'preserve-development', inst.out.slice(0, 400) + inst.err.slice(-400));
  st = status();
  check('setup: official 0.1.0 at the released HEAD', st?.state === 'official' && st?.git?.released_head === C1 && st?.restorable === true, JSON.stringify({ s: st?.state, r: st?.git?.released_head }));

  // A11–A13: development backups through the SDK.
  const act = sdk('dev', 'activate', ID, '--json');
  check('setup: dev activate', act.status === 0 && status()?.state === 'development');
  check('entering Development makes commits possible (repo-local placeholder identity)', act.json?.git_identity === 'placeholder'
    && git('config', '--local', 'user.email') === 'termux-os-local@localhost.invalid', JSON.stringify(act.json?.git_identity));
  const C2 = commit('web/style.css', '/* agent 2 */\n', 'agent 2');
  const bk = sdk('dev', 'backup', ID, '--json');
  check('A11 dev backup creates a whole-tree backup', bk.status === 0 && bk.json?.backup?.name && bk.json.backup.head === C2, bk.out + bk.err);
  const listed = sdk('dev', 'backups', ID, '--json');
  const named = listed.json?.backups?.find((b) => b.name === bk.json?.backup?.name);
  check('A12 dev backups lists it with branch and HEAD', listed.status === 0 && named?.head === C2 && named?.branch === 'dev/agent', listed.out.slice(0, 400));
  const C3 = commit('web/style.css', '/* agent 3 */\n', 'agent 3');
  const refused = sdk('dev', 'restore-backup', ID, bk.json?.backup?.name ?? 'x', '--json');
  check('A13 restore-backup over new history is refused by the Task04 guard', refused.status === 1
    && refused.json?.code === 'development_backup_required' && git('rev-parse', 'HEAD') === C3, refused.out);
  const restoredB = sdk('dev', 'restore-backup', ID, bk.json?.backup?.name ?? 'x', '--preserve-development', '--json');
  check('A13 restore-backup --preserve-development returns HEAD to the backup', restoredB.status === 0
    && git('rev-parse', 'HEAD') === C2 && restoredB.json?.after?.head === C2, restoredB.out + restoredB.err);
  check('A13 the displaced history was itself backed up', (sdk('dev', 'backups', ID, '--json').json?.backups ?? []).some((b) => b.head === C3));

  // A8: restore through the SDK — refused by default, then with a backup.
  const rDefault = sdk('restore', ID, '--json');
  check('A8 restore refuses by default (development_backup_required)', rDefault.status === 1
    && rDefault.json?.code === 'development_backup_required' && git('rev-parse', 'HEAD') === C2, rDefault.out);
  const rOk = sdk('restore', ID, '--preserve-development', '--json');
  st = status();
  check('A8 restore --preserve-development returns to official', rOk.status === 0 && st?.state === 'official'
    && st?.git?.head === C1 && rOk.json?.after?.state === 'official', rOk.out + rOk.err);

  // A9: a second Release (0.1.1), then rollback through the SDK.
  sdk('dev', 'activate', ID, '--json');
  const m2 = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); m2.version = '0.1.1';
  fs.writeFileSync(manifestPath, `${JSON.stringify(m2, null, 2)}\n`);
  git('commit', '-q', '-am', 'Release 0.1.1');
  const rel2 = sdk('release', ID, '--json');
  const inst2 = sdk('install', rel2.json?.release ?? 'missing', '--json');
  check('setup: 0.1.1 installed', inst2.status === 0 && status()?.version === '0.1.1', inst2.out.slice(-300) + inst2.err.slice(-300));
  check('A3 install --json reports the new active version, not the pre-restart record', inst2.json?.installed_version === '0.1.1', JSON.stringify(inst2.json));
  const rb = sdk('rollback', ID, '--json');
  check('A9 rollback switches back to 0.1.0', rb.status === 0 && rb.json?.to_version === '0.1.0' && status()?.version === '0.1.0', rb.out + rb.err);

  // A10: protected uninstall through the SDK.
  sdk('dev', 'activate', ID, '--json');
  const C4 = commit('web/style.css', '/* agent 4 */\n', 'agent 4');
  fs.mkdirSync(path.join(pkgRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'config', 'keep.json'), '{"keep":true}\n');
  const u1 = sdk('uninstall', ID, '--json');
  check('A10 uninstall refuses to destroy Development history', u1.status === 1 && u1.json?.code === 'development_backup_required'
    && fs.existsSync(path.join(pkgRoot, 'active.json')), u1.out);
  const both = sdk('uninstall', ID, '--preserve-development', '--force-discard', '--json');
  check('A10 conflicting protection flags → protection_options_conflict', both.status === 1 && both.json?.code === 'protection_options_conflict');
  const u2 = sdk('uninstall', ID, '--preserve-development', '--json');
  const backupsAfter = fs.readdirSync(path.join(home, '.termux-os', 'package-archives', ID)).filter((n) => n.endsWith('.tar.gz.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(home, '.termux-os', 'package-archives', ID, n), 'utf8')));
  check('A10 uninstall --preserve-development: removed, history backed up, config kept', u2.status === 0
    && !fs.existsSync(path.join(pkgRoot, 'active.json')) && backupsAfter.some((b) => b.head === C4)
    && fs.existsSync(path.join(pkgRoot, 'config', 'keep.json')), u2.out + u2.err);

  // JSON purity across every --json call above, plus the read-only commands.
  for (const args of [['context', '--json'], ['doctor', ID, '--json'], ['next', ID, '--json'], ['inspect', ID, '--json'],
    ['status', ID, '--json'], ['handoff', ID, '--json'], ['verify-device', ID, '--dev', '--json'], ['nope', '--json']]) sdk(...args);
  const impure = pure.filter((p) => !p.parsed);
  check(`JSON purity: ${pure.length} --json invocations, stdout is one JSON document each`, impure.length === 0, JSON.stringify(impure));
  check('no SDK command asked for curl or package-manager.mjs', pure.length > 30);
} catch (error) {
  failures += 1;
  console.log(`FAIL unexpected error — ${error?.stack ?? error}`);
} finally {
  await stopServer();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'dist', 'releases', ID), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.runtime', 'dev', 'gen', ID), { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
process.exit(failures ? 1 : 0);
