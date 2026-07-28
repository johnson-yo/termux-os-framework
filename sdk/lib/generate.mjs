/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FW_ROOT, defaultWorkspaceRoot, emit, fail } from './util.mjs';

const TYPES = ['service', 'app', 'adapter', 'asset'];
const MENU_PARENT = {
  service: '/admin/services',
  app: '/admin/applications',
  adapter: '/admin/adapters',
  asset: '/admin/packages',
};

export async function cmdNew(flags, pos) {
  const type = String(flags.type ?? '');
  const id = String(flags.id ?? '');
  const name = String(flags.name ?? '');
  if (!TYPES.includes(type)) {
    return fail(flags, 'invalid_type', `--type must be ${TYPES.join('|')}`,
      'Not sure? Run: termux-os-sdk choose');
  }
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){3,}$/.test(id)) {
    return fail(flags, 'invalid_package_id', `id "${id}" is invalid`,
      'Use at least four lowercase segments, for example github.termux-os.service.keyword-counter.');
  }
  if (!name) return fail(flags, 'missing_name', null, 'Add --name "Human Readable Name".');
  const wsRoot = flags.workspace ? path.resolve(String(flags.workspace)) : defaultWorkspaceRoot();
  const dir = flags['out-dir'] ? path.resolve(String(flags['out-dir'])) : path.join(wsRoot, id);
  const location = flags['out-dir'] ? `explicit --out-dir (${dir})`
    : flags.workspace ? `explicit --workspace (${wsRoot})`
      : `independent development root (${wsRoot})`;
  if (fs.existsSync(dir)) {
    return fail(flags, 'package_exists', dir, `Inspect it first: termux-os-sdk inspect ${id}`);
  }
  const short = id.split('.').pop();
  const v = { ID: id, NAME: name, TYPE: type, SHORT: short,
    SERVICE_ID: type === 'app' ? `app.${short}` : short };

  const files = { ...commonFiles(v), ...extraFiles[type](v) };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  fs.chmodSync(path.join(dir, 'scripts/smoke.sh'), 0o755);

  // Validate generated output immediately with the Core manifest validator.
  const { validateManifest } = await import(path.join(FW_ROOT, 'src/packages/manifest.mjs'));
  const check = validateManifest(JSON.parse(files['termux-os.package.json']));
  if (!check.ok) {
    return fail(flags, 'generated_manifest_invalid', check.errors.join('; '),
      'Report an SDK generator defect; the generated files remain available for inspection.');
  }

  const out = { ok: true, id, type, dir, location,
    files: Object.keys(files).sort(),
    next: [
      `Read ${path.relative(FW_ROOT, dir)}/AGENTS.md`,
      'Record the requirement and architecture decision in .sdk/project.v1.json or private notes (never add DEVELOPMENT.md to a release)',
      `termux-os-sdk test ${id}`,
      `termux-os-sdk doctor ${id}`,
    ] };
  emit(out, flags, (o) => {
    console.log(`✓ Generated ${o.type} Package: ${o.id}\n  Location: ${o.location}\n  ${o.dir}\n`);
    console.log(o.files.map((f) => `  ${f}`).join('\n'));
    console.log(`\nNext:\n${o.next.map((n) => `  ${n}`).join('\n')}`);
  });
}

// ============================================================
// Files shared by every Package type.
// ============================================================
function commonFiles(v) {
  return {
    'AGENTS.md': agentsMd(v),
    'README.md': `# ${v.NAME}\n\nTODO: Explain what this Package does and who uses it.\n\nType: ${v.TYPE}. User entry point: \`/packages/${v.ID}/\`.\nUse the current Framework's \`sdk/START_HERE.md\` for the development flow.\n`,
    // Mutable development evidence stays under .sdk/ and outside the Release.
    'RELEASE_NOTES.md': `# Release notes — ${v.ID}\n\n## 0.1.0 (unreleased)\n\n- Initial release: TODO describe the delivered behavior.\n\nFreeze this section before release. A post-release payload change requires a version change.\n`,
    'LICENSE': fs.readFileSync(path.join(FW_ROOT, 'LICENSE'), 'utf8'),
    'NOTICE.md': '# Notice\n\nThis Package starts under Apache-2.0. Add inherited third-party notices here when code, engines, models, data, or vendor artifacts are added.\n\nAI-Agent disclosure is optional reference information: if an AI Agent materially contributed, record the tool and scope here without placing credentials, private prompts, or internal notes in the release.\n',
    'termux-os.package.json': manifestJson(v),
    'scripts/verify-device.mjs': verifyDeviceMjs(v),
    'web/index.html': webIndex(v),
    'web/app.js': webApp(v),
    'web/style.css': WEB_STYLE,
    // Each type supplies a self-test for its own smallest behavior.
    'scripts/smoke.sh': smokeSh(v),
    '.sdk/project.v1.json': JSON.stringify({
      schema: 'termux-os.sdk-project.v1',
      package_id: v.ID,
      primary_type: v.TYPE,
      created_by: 'termux-os-sdk',
      requirements: {
        capabilities: [],
        feeds: [],
        ports: v.TYPE === 'service' ? ['http'] : [],
        menu_parent: MENU_PARENT[v.TYPE],
        browser_session: true,
      },
      development: { current_section: 0 },
    }, null, 2) + '\n',
  };
}

function manifestJson(v) {
  const m = {
    schema: 'termux-os.package.v1',
    id: v.ID,
    name: v.NAME,
    version: '0.1.0',
    description: `TODO: describe ${v.NAME}`,
    types: [v.TYPE],
    compatibility: { framework: '>=0.1.0' },
    entrypoints: { backend: 'package.mjs', webui: 'web/index.html' },
    admin: { title: v.NAME },
    verification: { device: { command: 'node scripts/verify-device.mjs', timeout_ms: 30000, requires_running: false } },
    components: {
      services: v.TYPE === 'service' ? [v.SERVICE_ID] : v.TYPE === 'app' ? [v.SERVICE_ID] : [],
      actions: v.TYPE === 'adapter' ? [`${v.SHORT}.probe`, `${v.SHORT}.echo`] : [],
      apps: v.TYPE === 'app' ? [v.SHORT] : [],
      ...(v.TYPE === 'asset' ? { assets: [`model.${v.SHORT}`] } : {}),
    },
    capabilities: { provides: [], requires: [] },
    menu: [{
      parent: MENU_PARENT[v.TYPE],
      path: `/packages/${v.ID}/`,
      title: v.NAME,
      order: 100,
    }],
    ...(v.TYPE === 'service' ? {
      ports: [{ id: 'http', protocol: 'http', visibility: 'loopback', health: '/health' }],
    } : {}),
    ...(v.TYPE === 'asset' ? {
      assets: {
        provides: [{ id: `model.${v.SHORT}`, kind: 'model', payload: `payload/${v.SHORT}`,
          files: { metadata: 'asset.json' } }],
        requires: [],
      },
    } : {}),
    runtime: { framework: { commands: ['node'] }, termux_packages: [], bundled: [], external: [] },
  };
  return JSON.stringify(m, null, 2) + '\n';
}

function agentsMd(v) {
  return `# Package instructions — ${v.ID}

## Responsibility
TODO: State one responsibility and the explicit non-responsibilities.

## Scope
Files in this Package repository may be changed. Do not change Framework Core, another Package, or existing user data to hide a Package defect.

## Runtime paths
- Ephemeral status: \`<frameworkRoot>/.runtime/services/<instance-scoped service id>/\`
  (use \`context.services.id('${v.SERVICE_ID}')\`; a Workspace instance is suffixed with its slug)
- Persistent configuration: \`/sdcard/termux-os/framework/conf/${v.SHORT}.v1.json\`
- Persistent data: \`/sdcard/termux-os/framework/data/${v.SHORT}/\`

Create persistent files only when missing and never overwrite user configuration during an update.

## Framework contracts
- Declare direct HTTP listeners in Manifest \`ports\`; read assigned values from
  \`PORT\` or \`TERMUX_OS_PORT_<ID>\`, and bind to the injected
  \`TERMUX_OS_PORT_<ID>_HOST\`.
- Supervised processes use \`TERMUX_OS_SYSTEM_KEY\` and
  \`TERMUX_OS_FRAMEWORK_URL\`. In-process code uses \`context.auth\` and
  \`context.ports\`. Never read Framework's internal auth config.
- WebUI uses \`/admin/session.js\` and \`window.TermuxOS.api\`; never add a token
  input or browser-stored credential.
- Keep the Package page portrait-phone-first and register only its owned
  \`/packages/${v.ID}/\` route in the Manifest menu.

## Commands
Use \`termux-os-sdk\` from \`PATH\`, or invoke
\`<framework-root>/sdk/termux-os-sdk\`.

- Test: \`termux-os-sdk test ${v.ID}\`
- Doctor: \`termux-os-sdk doctor ${v.ID}\`
- Release: \`termux-os-sdk release ${v.ID}\`
- Install: \`termux-os-sdk install <tar> --connection <name>\`

## Completion
The self-test passes, doctor has no failures, an immutable release is installed and device-verified, and the handoff records any known issues.
`;
}

function webIndex(v) {
  return `<!--
  SPDX-License-Identifier: Apache-2.0
  [INPUT]: Package status APIs and the Framework browser session.
  [OUTPUT]: The generated Package administration page.
  [POS]: web/index.html in the generated Extension Package.
  [PROTOCOL]: Keep this English header synchronized with Package behavior.
-->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${v.NAME}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>${v.NAME} <a class="back" href="/admin">Back to administration</a></h1>
  <section class="card">
    <h2>Status</h2>
    <pre id="status">-</pre>
    <p id="note" class="note"></p>
    <p class="note">Errors must explain what happened and what the user can do next.</p>
  </section>
  <section class="card">
    <h2>Verification</h2>
    <p><a class="back" href="/admin/status/runtime">Open runtime status</a></p>
  </section>
</main>
<script src="/admin/session.js"></script>
<script src="app.js"></script>
</body>
</html>
`;
}

function webApp(v) {
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
const PKG = '/api/packages/${v.ID}';
const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => window.TermuxOS.api(path, opts);

async function loadStatus() {
  try {
    const response = await api(PKG + '${v.TYPE === 'adapter' ? '/config' : '/status'}');
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? result.error ?? \`HTTP \${response.status}\`);
    $('status').textContent = JSON.stringify(result, null, 2);
    $('note').textContent = '';
  } catch (e) { $('note').textContent = String(e); }
}
window.TermuxOS.ready.then(() => {
  loadStatus();
  setInterval(loadStatus, 2000);
});
`;
}

const WEB_STYLE = `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The generated Package administration markup.
 * [OUTPUT]: Responsive styles for the generated Package page.
 * [POS]: web/style.css in the generated Extension Package.
 * [PROTOCOL]: Keep this English header synchronized with the generated page.
 */
* { box-sizing: border-box; margin: 0; }
body { font: 15px/1.5 system-ui, sans-serif; background: #0b0d10; color: #e8eaed; padding: 12px; }
main { width: min(720px, 100%); margin: 0 auto; }
h1 { font-size: 1.1rem; color: #8ab4f8; margin: .5rem 0; display: flex; justify-content: space-between; gap: .7rem; flex-wrap: wrap; }
h2 { font-size: 1rem; color: #8ab4f8; margin-bottom: .6rem; }
.card { background: #16181c; border: 1px solid #2a2f36; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
button { padding: 8px 14px; border: 0; border-radius: 6px; background: #2f6fed; color: #fff; cursor: pointer; }
pre { font-family: ui-monospace, monospace; font-size: .8rem; background: #111418; border: 1px solid #2a2f36;
  border-radius: 6px; padding: .5rem; white-space: pre-wrap; max-height: 20rem; overflow-y: auto; }
.note { color: #9aa0a6; font-size: .8rem; }
.back { color: #8ab4f8; font-size: .85rem; }
@media (max-width: 480px) {
  body { padding: 9px; font-size: 14px; }
  .card { padding: 10px; margin-bottom: 9px; }
  pre { max-height: 55vh; }
}
`;

function smokeSh(v) {
  return `#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: The generated Package backend and isolated self-test.
# [OUTPUT]: A truthful PASS/FAIL result for ${v.ID}.
# [POS]: scripts/smoke.sh in the generated Extension Package.
# [PROTOCOL]: Test only this Package; do not invoke unrelated historical suites.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail=0
node --check "$HERE/package.mjs" && echo "PASS backend syntax" || { echo "FAIL backend syntax"; fail=1; }
node "$HERE/test/self-test.mjs" || fail=1
echo "smoke: $([ $fail -eq 0 ] && echo ALL PASS || echo FAILED)"
exit $fail
`;
}

// ============================================================
// Type-specific files.
// ============================================================
const extraFiles = { service: serviceExtras, app: appExtras, adapter: adapterExtras, asset: assetExtras };

function serviceStatusLib() {
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';

export function writeStatus(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, updated_at: Date.now() }, null, 2));
  fs.renameSync(tmp, file);
}

export function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
`;
}

function serviceConfigLib(v) {
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  schema: 'termux-os-framework.${v.SHORT}.conf.v1',
  enabled: true,
  interval_ms: 1000,
};

export function loadConfig(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\\n');
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}
`;
}

function serviceMain(v) {
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import http from 'node:http';
import { writeStatus } from './status.mjs';
import { loadConfig } from './config.mjs';
import { systemKeyAuthorized } from './http-auth.mjs';

const STATUS_FILE = process.env.STATUS_FILE || '.runtime-dev/status.json';
const CONFIG_FILE = process.env.CONFIG_FILE || '.runtime-dev/conf.json';
const PORT = Number(process.env.PORT);
const BIND_HOST = process.env.TERMUX_OS_PORT_HTTP_HOST || '127.0.0.1';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';

const state = { state: 'starting', started_at: new Date().toISOString(),
  counter: 0, last_activity_ms: 0, last_error: null };
const flush = () => writeStatus(STATUS_FILE, state);

let cfg;
try { cfg = loadConfig(CONFIG_FILE); } catch (e) {
  state.state = 'error'; state.last_error = 'config unreadable: ' + e.message; flush();
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT <= 0 || !SYSTEM_KEY) {
  state.state = 'error';
  state.last_error = 'Framework did not inject PORT and TERMUX_OS_SYSTEM_KEY';
  flush();
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, service: '${v.SERVICE_ID}', state: state.state });
  }
  if (!systemKeyAuthorized(req.headers.authorization, SYSTEM_KEY)) {
    return send(401, { ok: false, error: 'unauthorized' });
  }
  if (req.method === 'GET' && req.url === '/status') {
    return send(200, { ok: true, service: '${v.SERVICE_ID}', status: state });
  }
  return send(404, { ok: false, error: 'not_found' });
});

server.listen(PORT, BIND_HOST, () => {
  console.log('[${v.SERVICE_ID}] started host=' + BIND_HOST + ' port=' + PORT + ' interval=' + cfg.interval_ms + 'ms status=' + STATUS_FILE);
});
flush();

// TODO: Replace this timer with the real queue, feed, or stateful work.
// Record activity only when real work happened; keep the last error visible.
const timer = setInterval(() => {
  try {
    state.counter += 1;
    state.last_activity_ms = Date.now();
    state.state = 'idle';
    state.last_error = null;
  } catch (e) {
    state.state = 'degraded';
    state.last_error = String(e.message ?? e);
  }
  flush();
}, cfg.interval_ms);

const bye = () => {
  clearInterval(timer);
  state.state = 'stopped';
  flush();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
`;
}

function serviceHttpAuth() {
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An HTTP Authorization header and the Framework-injected System Key.
 * [OUTPUT]: Whether the request carries the exact shared System Key.
 * [POS]: service/http-auth.mjs in a generated Extension Package.
 * [PROTOCOL]: Never log, persist, or copy the System Key.
 */

export function systemKeyAuthorized(header, systemKey) {
  return Boolean(systemKey) && header === \`Bearer \${systemKey}\`;
}
`;
}

function servicePackageMjs(v) {
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './service/config.mjs';

const EDITABLE = { interval_ms: 'number' };

export async function register(context) {
  // Derive runtime paths from the instance-scoped service id, never from the literal
  // one: a Workspace runs alongside the released Package, and two instances that
  // build this path from the same constant read and write each other's status file.
  const SERVICE_ID = context.services.id('${v.SERVICE_ID}');
  const STATUS_FILE = path.join(context.frameworkRoot, \`.runtime/services/\${SERVICE_ID}/status.json\`);
  const CONFIG_FILE = path.join(context.persistRoot, 'conf/${v.SHORT}.v1.json');

  context.services.register({
    id: '${v.SERVICE_ID}',
    name: '${v.NAME}',
    command: context.nodeExecutable,
    args: ['service/main.mjs'],
    cwd: context.root,
    // Core also injects PORT, TERMUX_OS_PORT_HTTP, TERMUX_OS_SYSTEM_KEY,
    // TERMUX_OS_FRAMEWORK_URL, and TERMUX_OS_PACKAGE_ID.
    env: { STATUS_FILE, CONFIG_FILE },
    stop_timeout_ms: 5000,
  });

  context.routes.register('GET', '/status', async (req, res, { json }) => {
    let status = null;
    try { status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { /* Not started yet. */ }
    json(res, 200, { ok: true, service: '${v.SERVICE_ID}', status,
      assigned_port: context.ports.get('http'),
      hint: status ? null : 'Start this service from Administration / Services or the Stage service API.' });
  });

  // Configuration may be edited before the service has ever started.
  context.routes.register('GET', '/config', async (req, res, { json }) => {
    json(res, 200, { ok: true, config: loadConfig(CONFIG_FILE), editable: Object.keys(EDITABLE), restart_required: true });
  });

  context.routes.register('POST', '/config', async (req, res, { json, readBody }) => {
    const body = await readBody();
    if (!body) return json(res, 400, { ok: false, error: 'invalid json' });
    const cfg = loadConfig(CONFIG_FILE);
    const applied = [];
    for (const [k, t] of Object.entries(EDITABLE)) {
      if (body[k] !== undefined) {
        if (typeof body[k] !== t) return json(res, 400, { ok: false, error: k + ' must be ' + t });
        cfg[k] = body[k]; applied.push(k);
      }
    }
    if (!applied.length) return json(res, 400, { ok: false, error: 'no editable field', editable: Object.keys(EDITABLE) });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\\n');
    json(res, 200, { ok: true, applied, restart_required: true });
  });
}
`;
}

function serviceSelfTest(v) {
  return `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStatus, readStatus } from '../service/status.mjs';
import { loadConfig } from '../service/config.mjs';
import { systemKeyAuthorized } from '../service/http-auth.mjs';

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '${v.SHORT}-'));
const sf = path.join(tmp, 'status.json');

writeStatus(sf, { state: 'idle', counter: 3 });
t('status is written atomically', readStatus(sf).counter === 3 && readStatus(sf).updated_at > 0);
t('missing status returns null', readStatus(path.join(tmp, 'nope.json')) === null);
t('atomic write leaves no temporary file', !fs.readdirSync(tmp).some((f) => f.endsWith('.tmp')));

const cf = path.join(tmp, 'conf.json');
const c1 = loadConfig(cf);
t('missing config is created from defaults', c1.interval_ms === 1000 && fs.existsSync(cf));
fs.writeFileSync(cf, JSON.stringify({ interval_ms: 250 }));
t('existing config is preserved', loadConfig(cf).interval_ms === 250);
t('System Key authentication accepts only the exact key',
  systemKeyAuthorized('Bearer test-key', 'test-key')
    && !systemKeyAuthorized('Bearer wrong', 'test-key')
    && !systemKeyAuthorized(undefined, 'test-key'));

// TODO: Add isolated tests for the Package's real behavior.

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
`;
}

function serviceExtras(v) {
  return {
    'package.mjs': servicePackageMjs(v),
    'service/main.mjs': serviceMain(v),
    'service/status.mjs': serviceStatusLib(),
    'service/config.mjs': serviceConfigLib(v),
    'service/http-auth.mjs': serviceHttpAuth(),
    'test/self-test.mjs': serviceSelfTest(v),
  };
}

// ---- app ----
function appExtras(v) {
  return {
    'package.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function register(context) {
  const manifest = JSON.parse(fs.readFileSync(path.join(context.root, 'termux-os.package.json'), 'utf8'));
  const STATUS = path.join(context.frameworkRoot, '.runtime/services/${v.SERVICE_ID}/status.json');

  context.services.register({
    id: '${v.SERVICE_ID}',
    name: '${v.NAME} Worker',
    command: context.nodeExecutable,
    args: ['app/worker.mjs'],
    cwd: context.root,
    env: {
      STATUS_FILE: STATUS,
      CURSOR_FILE: path.join(context.frameworkRoot, '.runtime/services/${v.SERVICE_ID}/cursor.json'),
    },
    stop_timeout_ms: 5000,
  });

  context.apps.register({
    id: '${v.SHORT}',
    name: manifest.name,
    url: '/packages/' + context.packageId + '/',
    requires: manifest.capabilities.requires,
  });

  context.routes.register('GET', '/status', async (req, res, { json }) => {
    let worker = null;
    try { worker = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { /* Not started yet. */ }
    json(res, 200, { ok: true, worker,
      hint: worker ? null : 'Start this worker from Administration / Services or the Stage service API.' });
  });
}
`,
    'app/worker.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import { readState, writeState } from './state.mjs';

const FW = process.env.TERMUX_OS_FRAMEWORK_URL || '';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';
const STATUS_FILE = process.env.STATUS_FILE || '.runtime-dev/status.json';
const CURSOR_FILE = process.env.CURSOR_FILE || '.runtime-dev/cursor.json';

const api = async (p, opts = {}) => {
  if (!FW || !SYSTEM_KEY) throw new Error('Framework URL or System Key was not injected');
  const r = await fetch(FW + p, {
    ...opts,
    headers: { Authorization: 'Bearer ' + SYSTEM_KEY, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error('Framework HTTP ' + r.status + ' for ' + p);
  return r.json();
};

const state = { state: 'starting', started_at: new Date().toISOString(),
  consumed: 0, last_item: null, last_error: null };
const flush = () => writeState(STATUS_FILE, state);
flush();

// TODO: Replace this with the Capability consumed by the real workflow.
const FEED_CAPABILITY = 'speech.transcript';

let running = true;
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

const cursor = readState(CURSOR_FILE) ?? { after: 0, seen: [] };

async function loop() {
  // Resolve the provider-neutral descriptor before reading a feed.
  const d = await api('/api/capabilities/' + FEED_CAPABILITY);
  if (!d?.endpoint) { state.state = 'degraded'; state.last_error = FEED_CAPABILITY + ' descriptor unavailable'; flush(); return; }
  state.state = 'idle'; flush();
  while (running) {
    try {
      // TODO: Adapt this example to the descriptor's documented feed shape.
      const r = await api(d.endpoint + '?after=' + cursor.after + '&limit=20');
      for (const item of r.utterances ?? []) {
        const id = item.utterance_id ?? JSON.stringify(item);
        if (cursor.seen.includes(id)) continue;
        // TODO: Perform the real workflow behavior here.
        state.consumed += 1;
        state.last_item = id;
        cursor.after = item.timing?.written_ms ?? cursor.after;
        cursor.seen = [...cursor.seen.slice(-63), id];
        writeState(CURSOR_FILE, cursor);
      }
      state.state = 'active'; state.last_error = null;
    } catch (e) { state.state = 'degraded'; state.last_error = String(e.message ?? e); }
    flush();
    await new Promise((r) => setTimeout(r, 1000));
  }
  state.state = 'stopped'; flush();
}
loop().then(() => process.exit(0));
`,
    'app/state.mjs': serviceStatusLib().replaceAll('writeStatus', 'writeState').replaceAll('readStatus', 'readState'),
    'corpus/README.md': 'Place only redistributable, non-sensitive corpus or static fixture data here. Remove this directory when it is unused.\n',
    'test/self-test.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeState, readState } from '../app/state.mjs';

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '${v.SHORT}-'));
const cf = path.join(tmp, 'cursor.json');
writeState(cf, { after: 42, seen: ['a'] });
t('cursor state survives a restart', readState(cf).after === 42);
t('missing state returns null', readState(path.join(tmp, 'no.json')) === null);
// TODO: Add matching, ordering, and duplicate-suppression tests.
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
`,
  };
}

// ---- adapter ----
function adapterExtras(v) {
  return {
    'package.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './adapter/config.mjs';
import { makeActions } from './adapter/actions.mjs';

export async function register(context) {
  const CONF = path.join(context.persistRoot, 'conf/${v.SHORT}.v1.json');
  const cfg = () => loadConfig(CONF);
  for (const a of makeActions(cfg)) context.actions.register(a);

  // TODO: Publish a Capability only after the external provider is usable:
  // context.capabilities.provide({ id: '<capability>', provider: '${v.SHORT}', kind: 'action', action: '${v.SHORT}.echo' });

  context.routes.register('GET', '/config', async (req, res, { json }) => {
    const c = cfg();
    json(res, 200, { ok: true, config: { ...c, credential: c.credential ? '***' : '' }, path: CONF });
  });
  context.routes.register('POST', '/config', async (req, res, { json, readBody }) => {
    const body = await readBody();
    if (!body) return json(res, 400, { ok: false, error: 'invalid json' });
    const applied = saveConfig(CONF, body);
    if (!applied.length) return json(res, 400, { ok: false, error: 'no editable field (endpoint/credential)' });
    json(res, 200, { ok: true, applied });
  });
  // Exercise the registered Action path and report each observed layer separately.
  context.routes.register('POST', '/test', async (req, res, { json }) => {
    const { probe } = await import('./adapter/probe.mjs');
    const reachable = await probe(cfg());
    let invoked = null;
    if (reachable.ok) {
      try { invoked = { ok: true, value: await makeActions(cfg()).find((a) => a.id === '${v.SHORT}.echo').run('ping') }; }
      catch (e) { invoked = { ok: false, error: String(e.message ?? e) }; }
    }
    json(res, 200, { ok: true, reachable, registered: true, invoked,
      hint: reachable.ok ? null : 'Configure the endpoint on this Package page and verify that the provider is running.' });
  });
}
`,
    'adapter/config.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = { schema: 'termux-os-framework.${v.SHORT}.conf.v1', endpoint: '', credential: '' };
const EDITABLE = ['endpoint', 'credential'];

export function loadConfig(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\\n');
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function saveConfig(file, body) {
  const cfg = loadConfig(file);
  const applied = [];
  for (const k of EDITABLE) {
    if (typeof body[k] === 'string') { cfg[k] = body[k]; applied.push(k); }
  }
  if (applied.length) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\\n');
  return applied;
}
`,
    'adapter/client.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
export async function call(cfg, path, init = {}) {
  if (!cfg.endpoint) throw new Error('endpoint not configured on this Package page');
  const r = await fetch(cfg.endpoint + path, {
    ...init,
    headers: { ...(cfg.credential ? { Authorization: 'Bearer ' + cfg.credential } : {}), 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(init.timeout ?? 5000),
  });
  if (!r.ok) throw new Error('vendor http ' + r.status);
  return r.json();
}
`,
    'adapter/probe.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import { call } from './client.mjs';

export async function probe(cfg) {
  if (!cfg.endpoint) return { ok: false, reason: 'endpoint not configured' };
  try { await call(cfg, '/health', { timeout: 2000 }); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e.message ?? e) }; }
}
`,
    'adapter/actions.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import { call } from './client.mjs';
import { probe } from './probe.mjs';

export const makeActions = (cfg) => [
  {
    id: '${v.SHORT}.probe',
    name: '${v.NAME} Probe',
    adapter: '${v.SHORT}',
    available: async () => true,
    run: async () => probe(cfg()),
  },
  {
    id: '${v.SHORT}.echo',
    name: '${v.NAME} Echo',
    adapter: '${v.SHORT}',
    available: async () => (await probe(cfg())).ok,
    run: async (value) => {
      // TODO: Replace this fixture with the external provider's documented API call.
      return { echo: value };
    },
  },
];
`,
    'test/self-test.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, saveConfig } from '../adapter/config.mjs';
import { probe } from '../adapter/probe.mjs';
import { makeActions } from '../adapter/actions.mjs';

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '${v.SHORT}-'));
const cf = path.join(tmp, 'conf.json');

t('missing config starts with an empty endpoint', loadConfig(cf).endpoint === '');
t('probe truthfully fails before configuration', (await probe(loadConfig(cf))).ok === false);

const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
saveConfig(cf, { endpoint: 'http://127.0.0.1:' + srv.address().port });

t('fixture provider is reachable', (await probe(loadConfig(cf))).ok === true);
const actions = makeActions(() => loadConfig(cf));
t('registered echo Action is available and callable', (await actions[1].available()) === true
  && (await actions[1].run('hi')).echo === 'hi');

srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
`,
  };
}

// ---- asset ----
function assetExtras(v) {
  return {
    'package.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
export async function register(context) {
  context.routes.register('GET', '/status', async (req, res, { json }) => {
    json(res, 200, { ok: true, asset: context.assets.resolve('model.${v.SHORT}') });
  });
}
`,
    'asset/asset.json': JSON.stringify({
      schema: 'termux-os.package-asset.v1',
      id: `model.${v.SHORT}`,
      model: v.SHORT,
      note: 'TODO: Record the real target, runtime, and checksum metadata.',
    }, null, 2) + '\n',
    'payload/README.md': `Place the licensed payload under payload/${v.SHORT}/ or inject the same relative layout with --artifact-dir.\nRelease verifies that every asset declared by the Manifest exists in the archive.\n`,
    'test/self-test.mjs': `/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(path.dirname(new URL(import.meta.url).pathname));
let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const m = JSON.parse(fs.readFileSync(path.join(HERE, 'termux-os.package.json'), 'utf8'));
t('asset Package declares no services or actions',
  m.types.includes('asset') && !m.components.services.length && !m.components.actions.length);
t('asset declarations match components.assets',
  m.assets.provides.every((a) => m.components.assets.includes(a.id)));
const aj = JSON.parse(fs.readFileSync(path.join(HERE, 'asset/asset.json'), 'utf8'));
t('asset metadata ID matches the manifest', aj.id === m.assets.provides[0].id);
process.exit(fails ? 1 : 0);
`,
  };
}

// ============================================================
// Device verification runs on the target and must report only observed evidence.
// ============================================================
function verifyDeviceMjs(v) {
  const statusPath = v.TYPE === 'adapter' ? '/config' : '/status';
  return `#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// [INPUT]: FRAMEWORK_URL, TERMUX_OS_TOKEN, and the installed Framework HTTP API.
// [OUTPUT]: One termux-os.device-verify.v1 JSON result and a truthful exit status.
// [POS]: The generated Package device-verification hook.
// [PROTOCOL]: Keep this English header synchronized with Package behavior.
const BASE = process.env.TERMUX_OS_FRAMEWORK_URL ?? 'http://127.0.0.1:8980';
const TOKEN = process.env.TERMUX_OS_SYSTEM_KEY ?? process.env.TERMUX_OS_TOKEN ?? '';
const checks = [];
const check = async (id, fn) => {
  try { checks.push({ id, result: 'pass', evidence: await fn() }); }
  catch (e) { checks.push({ id, result: 'fail', evidence: String(e?.message ?? e) }); }
};
const get = async (p, auth) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(5000),
    headers: auth ? { Authorization: \`Bearer \${TOKEN}\` } : {} });
  if (r.status !== 200) throw new Error(\`HTTP \${r.status} \${p}\`);
  return \`HTTP 200 \${p}\`;
};

await check('package_identity', () => get('/api/packages/${v.ID}', true));
await check('${statusPath === '/status' ? 'status_api' : 'config_api'}', () => get('/api/packages/${v.ID}${statusPath}', true));
// TODO: Add real device, data, configuration, and clean-stop checks.
// Use degraded or skip for unavailable optional behavior; never invent a pass.

const result = checks.some((c) => c.result === 'fail') ? 'fail' : 'pass';
console.log(JSON.stringify({ schema: 'termux-os.device-verify.v1', result, checks }));
process.exit(result === 'fail' ? 1 : 0);
`;
}
