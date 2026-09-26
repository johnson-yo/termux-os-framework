#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: This Framework checkout, `git`, and a temporary Installed Root with one fixture Package.
 * [OUTPUT]: PASS/FAIL lines for Dev Runtime change detection, last-good reload, configRoot, and marker contracts.
 * [POS]: scripts/smoke-dev-runtime-resilience.mjs in termux-os-framework.
 * [PROTOCOL]: Edits are written the way agents and editors write them (temp file + rename), because
 *             that is what a recursive fs.watch stops reporting after the first save. Isolated:
 *             temporary directories, a private port, no device, no network.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8969;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'resilience-smoke-token';
const ID = 'github.termux-os.app.dev-resilience';
const SERVICE = 'app.dev-resilience';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-resilience-'));
const installed = path.join(work, 'packages');
const packageRoot = path.join(installed, ID);
const V = path.join(packageRoot, 'versions', '0.1.0');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (...args) => execFileSync('git', ['-C', V, ...args], { env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** Write the way an agent does: a new inode renamed over the old path. */
function atomicWrite(rel, content) {
  const file = path.join(V, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

const backend = (value, extra = '') => `export async function register(context) {
  const VALUE = ${JSON.stringify(value)};
  ${extra}
  context.services.register({ id: '${SERVICE}', name: 'Resilience worker', command: context.nodeExecutable,
    args: ['-e', 'setInterval(() => {}, 1000)'], cwd: context.root });
  context.routes.register('GET', '/runtime', async (req, res, { json }) => json(res, 200, {
    ok: true, value: VALUE, root: context.root, configRoot: context.configRoot }));
}
`;
const page = (marker) => `<!doctype html><html><body><p id="marker">${marker}</p><script src="app.js"></script></body></html>\n`;

function writeFixture() {
  fs.mkdirSync(path.join(V, 'web'), { recursive: true });
  fs.writeFileSync(path.join(V, 'termux-os.package.json'), `${JSON.stringify({
    schema: 'termux-os.package.v1', id: ID, name: 'Dev resilience fixture', version: '0.1.0', types: ['app'],
    entrypoints: { backend: 'package.mjs', webui: 'web/index.html' },
    components: { services: [SERVICE], actions: [], apps: [] }, capabilities: { provides: [], requires: [] },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(V, 'package.mjs'), backend('main-0'));
  fs.writeFileSync(path.join(V, 'web', 'index.html'), page('main'));
  fs.writeFileSync(path.join(V, 'web', 'app.js'), 'window.APP = 0;\n');
  fs.writeFileSync(path.join(packageRoot, 'active.json'), `${JSON.stringify({
    schema: 'termux-os.package-active.v1', id: ID, active_version: '0.1.0', active_target: 'generic',
    previous_version: null, archive_sha256: null, installed_at: new Date().toISOString(), hashes: {},
  })}\n`);
  git('init', '-q', '-b', 'main');
  git('add', '-A'); git('commit', '-qm', 'A');
  git('switch', '-qc', 'dev/test');
  fs.writeFileSync(path.join(V, 'package.mjs'), backend('dev-0'));
  fs.writeFileSync(path.join(V, 'web', 'index.html'), page('dev'));
  git('commit', '-qam', 'C');
  git('switch', '-q', 'main');
  fs.mkdirSync(path.join(packageRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'config', 'sentinel.json'), '{"kept":true}\n');
}

const api = async (p, { method = 'GET', body, cookie } = {}) => {
  const headers = cookie ? { Cookie: cookie } : { Authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text), text }; } catch { return { status: r.status, data: null, text }; }
};
const runtime = async () => (await api(`/api/packages/${ID}/runtime`)).data;
const events = async () => (await api(`/api/dev/packages/${ID}/events`)).data;
const status = async () => (await api(`/api/dev/packages/${ID}/status`)).data;
const service = async () => (await api('/api/stage/services')).data?.services?.find((s) => s.id === SERVICE) ?? null;
async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last) return last;
    await sleep(100);
  }
  return null;
}

let server;
let cookie = null;
async function startServer() {
  server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(PORT), FRAMEWORK_ADMIN_TOKEN: TOKEN,
      FRAMEWORK_ADMIN_PASSWORD: TOKEN, PACKAGES_INSTALLED_DIR: installed,
      BROWSER_SESSION_PATH: path.join(work, 'sessions.json'), TERMUX_OS_DEV_ROOT: path.join(work, 'legacy'),
      PORT_REGISTRY_PATH: path.join(work, 'ports.v1.json'), TERMUX_OS_DEV_SCAN_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
  const up = await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 15000);
  if (!up) throw new Error('Framework did not start');
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] || null;
}

try {
  writeFixture();
  await startServer();
  const configRoot = path.join(packageRoot, 'config');

  const loaded = await waitFor(async () => (await runtime())?.value === 'main-0');
  check('fixture Package loads from the Installed Root', Boolean(loaded));
  check('T8 normal load: configRoot is <packageRoot>/config', (await runtime())?.configRoot === configRoot);
  await api(`/api/stage/services/${SERVICE}/start`, { method: 'POST' });
  const svcStarted = await waitFor(async () => (await service())?.process?.state === 'running');
  check('fixture service runs', Boolean(svcStarted));

  const started = await api('/api/dev/packages', { method: 'POST', body: { package_id: ID } });
  check('dev start', started.data?.ok === true, started.text);
  check('watch mode combines fs.watch with reconciliation', started.data?.watcher?.watch_mode === 'fs-watch+scan');

  // T1: the same web file, atomically replaced five times.
  let seq = (await events()).seq;
  let t1 = 0;
  for (let i = 1; i <= 5; i += 1) {
    atomicWrite('web/app.js', `window.APP = ${i};\n`);
    const next = await waitFor(async () => { const e = await events(); return e.seq > seq ? e : null; });
    if (next) { t1 += 1; seq = next.seq; }
  }
  check('T1 atomic web replace ×5 each advances seq', t1 === 5, `${t1}/5`);
  const genBeforeWeb = (await status()).runtime_generation;

  // T2: the same backend file, atomically replaced five times.
  let t2 = 0;
  let gens = new Set([genBeforeWeb]);
  for (let i = 1; i <= 5; i += 1) {
    atomicWrite('package.mjs', backend(`main-${i}`));
    const ok = await waitFor(async () => (await runtime())?.value === `main-${i}`);
    const gen = (await status()).runtime_generation;
    if (ok && !gens.has(gen)) { t2 += 1; gens.add(gen); }
  }
  check('T2 atomic backend replace ×5 each reloads to a new generation', t2 === 5, `${t2}/5`);
  check('T1 web-only batches did not reload the backend', genBeforeWeb === null || gens.size === 6);
  check('T8 dev reload: configRoot stays <packageRoot>/config', (await runtime())?.configRoot === configRoot);
  check('T8 dev reload: code root is a generation, not the config root', (await runtime())?.root !== path.dirname(configRoot));

  // T3: after an atomic replace, a plain in-place write is still seen.
  seq = (await events()).seq;
  fs.writeFileSync(path.join(V, 'web', 'app.js'), 'window.APP = "inplace";\n');
  check('T3 in-place web edit after atomic replace', Boolean(await waitFor(async () => (await events()).seq > seq)));
  fs.writeFileSync(path.join(V, 'package.mjs'), backend('main-inplace'));
  check('T3 in-place backend edit after atomic replace', Boolean(await waitFor(async () => (await runtime())?.value === 'main-inplace')));

  // T4: add, delete, rename.
  for (const [name, action] of [
    ['add', () => fs.writeFileSync(path.join(V, 'web', 'extra.js'), '1;\n')],
    ['rename', () => fs.renameSync(path.join(V, 'web', 'extra.js'), path.join(V, 'web', 'moved.js'))],
    ['delete', () => fs.rmSync(path.join(V, 'web', 'moved.js'))],
  ]) {
    seq = (await events()).seq;
    action();
    check(`T4 web ${name} is detected`, Boolean(await waitFor(async () => (await events()).seq > seq)));
  }
  let gen = (await status()).runtime_generation;
  fs.mkdirSync(path.join(V, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(V, 'lib', 'helper.mjs'), 'export const x = 1;\n');
  check('T4 new backend file reloads', Boolean(await waitFor(async () => (await status()).runtime_generation !== gen)));
  fs.rmSync(path.join(V, 'lib'), { recursive: true, force: true });
  await sleep(2500);

  // .git activity alone must not reload anything.
  git('checkout', '-q', '--', '.');
  git('clean', '-qfd');
  await waitFor(async () => (await runtime())?.value === 'main-0', 8000);
  await sleep(2500);
  seq = (await events()).seq; gen = (await status()).runtime_generation;
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  git('branch', 'scratch'); git('branch', '-D', 'scratch');
  await sleep(3000);
  check('.git-only activity triggers no reload', (await events()).seq === seq && (await status()).runtime_generation === gen);

  // T5: repeated branch switches keep web and backend on the same HEAD, one batch per switch.
  let t5 = 0;
  const webMarker = async () => (await api(`/packages/${ID}/`, { cookie })).text.match(/id="marker">(\w+)</)?.[1] ?? null;
  for (const branch of ['dev/test', 'main', 'dev/test', 'main']) {
    const expected = branch === 'main' ? 'main' : 'dev';
    const before = (await events()).seq;
    git('switch', '-q', branch);
    const aligned = await waitFor(async () => {
      const r = await runtime();
      return r?.value === `${expected}-0` && (await webMarker()) === expected ? r : null;
    }, 10000);
    await sleep(1500);
    const after = (await events()).seq;
    if (aligned && after - before <= 2) t5 += 1;
  }
  check('T5 git switch ×4: web and backend always match HEAD without reload storms', t5 === 4, `${t5}/4`);

  // T6: candidate failures keep the last-good runtime serving.
  for (const [name, source] of [
    ['syntax error', `${backend('main-0')}\nexport const broken = ;\n`],
    ['import error', `import './missing-module.mjs';\n${backend('main-0')}`],
    ['register() throw', backend('main-0', "throw new Error('register exploded');")],
  ]) {
    const pidBefore = (await service())?.process?.pid;
    atomicWrite('package.mjs', source);
    const failedEvent = await waitFor(async () => { const e = await events(); return e.last_reload_result === 'failed' ? e : null; });
    const r = await runtime();
    const svc = await service();
    check(`T6 ${name}: failure visible as dev_reload_failed`, failedEvent?.last_reload_error?.code === 'dev_reload_failed',
      JSON.stringify(failedEvent));
    check(`T6 ${name}: last-good API still answers`, r?.value === 'main-0', JSON.stringify(r));
    check(`T6 ${name}: service still running`, svc?.process?.state === 'running');
    if (name !== 'register() throw') {
      // Preflight failures happen before anything live is touched: the same process keeps running.
      check(`T6 ${name}: service process untouched`, svc?.process?.pid === pidBefore, `${pidBefore} → ${svc?.process?.pid}`);
    }
    check(`T6 ${name}: Package status stays loaded`, (await status()).status === 'loaded');
    // T7: the next ordinary save recovers on its own.
    atomicWrite('package.mjs', backend(`fixed-${name.length}`));
    const recovered = await waitFor(async () => (await runtime())?.value === `fixed-${name.length}`);
    check(`T7 ${name}: next atomic save recovers automatically`, Boolean(recovered));
    check(`T7 ${name}: last result is loaded again`,
      Boolean(await waitFor(async () => (await events()).last_reload_result === 'loaded')));
    atomicWrite('package.mjs', backend('main-0'));
    await waitFor(async () => (await runtime())?.value === 'main-0');
  }

  // T8: Package restart loads current code and keeps configRoot; the stable code reaches the SDK.
  const failedReload = await api(`/api/dev/packages/${ID}/reload`, { method: 'POST' });
  check('dev reload success response', failedReload.data?.ok === true, failedReload.text);
  await api(`/api/dev/packages/${ID}/stop`, { method: 'POST' });
  fs.writeFileSync(path.join(V, 'package.mjs'), backend('restart-new'));
  const restart = await api(`/api/admin/package-settings/${ID}/restart`, { method: 'POST', body: { confirm_package_id: ID } });
  check('T8 package-settings restart succeeds', restart.data?.ok === true, restart.text);
  const afterRestart = await runtime();
  check('T8 package-settings restart runs the new code', afterRestart?.value === 'restart-new', JSON.stringify(afterRestart));
  check('T8 package-settings restart: configRoot is <packageRoot>/config', afterRestart?.configRoot === configRoot);
  check('T8 config sentinel survives every reload', fs.existsSync(path.join(configRoot, 'sentinel.json')));

  // T9: an open page survives dev stop/start.
  const stopped = await api(`/api/dev/packages/${ID}/events`);
  check('T9 events answer watching:false while stopped (no 404 that reloads the page)',
    stopped.status === 200 && stopped.data?.watching === false, stopped.text);
  const restarted = await api('/api/dev/packages', { method: 'POST', body: { package_id: ID } });
  const session = restarted.data?.watcher?.session;
  check('T9 dev start exposes a new watcher session', typeof session === 'string' && session.length > 0);
  const html = (await api(`/packages/${ID}/`, { cookie })).text;
  check('T9 served dev page embeds the session and the stop-tolerant poll',
    html.includes(JSON.stringify(session)) && html.includes('d.watching===false'));
  await api(`/api/dev/packages/${ID}/stop`, { method: 'POST' });
} catch (error) {
  failures += 1;
  console.log(`FAIL unexpected error — ${error?.stack ?? error}`);
} finally {
  server?.kill();
  await sleep(300);
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.runtime', 'dev', 'gen', ID), { recursive: true, force: true });
}
console.log(failures ? `dev runtime resilience: ${failures} FAIL` : 'dev runtime resilience: ALL PASS');
process.exit(failures ? 1 : 0);
