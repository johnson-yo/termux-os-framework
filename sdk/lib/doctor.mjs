/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/doctor.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FW_ROOT, emit, fail, packageDir, runCapture } from './util.mjs';

const CODE_EXT = new Set(['.mjs', '.js', '.py', '.sh']);

function* codeFiles(dir, rel = '') {
  for (const name of fs.readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    const p = path.join(dir, r);
    if (fs.statSync(p).isDirectory()) {
      if (!['node_modules', '.git', 'payload'].includes(name)) yield* codeFiles(dir, r);
    } else if (CODE_EXT.has(path.extname(name))) yield r;
  }
}

export async function collectDoctor(id) {
  const dir = packageDir(id);
  const results = [];
  const add = (level, check, detail = null, fix = null) =>
    results.push({ level, check, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) });

  if (!fs.existsSync(dir)) return { results: [{ level: 'FAIL', check: 'package_exists', detail: dir, fix: `termux-os-sdk new --id ${id} --type <type> --name "<Name>"` }] };

  // Manifest: the Core validator is the single source of truth.
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'termux-os.package.json'), 'utf8')); }
  catch (e) { add('FAIL', 'manifest_readable', String(e.message), 'Fix the JSON syntax in termux-os.package.json.'); }
  if (m) {
    const { validateManifest } = await import(path.join(FW_ROOT, 'src/packages/manifest.mjs'));
    const v = validateManifest(m);
    if (v.ok) add('PASS', 'manifest_valid');
    else add('FAIL', 'manifest_valid', v.errors.join('; '), 'Fix each manifest error using sdk/CONTRACTS.md.');
    if (m.id === id) add('PASS', 'id_matches_dir');
    else add('FAIL', 'id_matches_dir', `manifest.id=${m.id} does not match ${id}`, 'The source directory name must equal the Package ID.');
  }

  // Entry points.
  const backend = m?.entrypoints?.backend ?? 'package.mjs';
  if (fs.existsSync(path.join(dir, backend))) {
    const c = runCapture('node', ['--check', path.join(dir, backend)]);
    if (c.status === 0) add('PASS', 'backend_syntax');
    else add('FAIL', 'backend_syntax', c.stderr.split('\n')[0], `Run node --check ${backend} for the full error.`);
  } else add('FAIL', 'backend_exists', backend, 'Every Package requires a backend entry point.');
  const webui = m?.entrypoints?.webui ?? 'web/index.html';
  if (fs.existsSync(path.join(dir, webui))) add('PASS', 'webui_exists');
  else add('FAIL', 'webui_exists', webui, 'Every administrable Package requires a WebUI.');

  // Documentation.
  for (const [f, level] of [['README.md', 'FAIL'], ['AGENTS.md', 'FAIL'], ['NOTICE.md', 'FAIL']]) {
    if (fs.existsSync(path.join(dir, f))) add('PASS', `doc:${f}`);
    else add(level, `doc:${f}`, 'missing', f === 'README.md'
      ? 'Describe the Package before release.'
      : `Create ${f} using a current SDK-generated Package as the reference.`);
  }
  if (fs.existsSync(path.join(dir, 'CLAUDE.md')) || fs.existsSync(path.join(dir, 'DEVELOPMENT.md'))) {
    add('FAIL', 'public_docs_no_internal_files', 'CLAUDE.md/DEVELOPMENT.md must not be part of a Package source release',
      'Move development notes under .sdk/ or the Framework SDK; publish contributor instructions as AGENTS.md.');
  } else add('PASS', 'public_docs_no_internal_files');
  if (fs.existsSync(path.join(dir, '.sdk/handoff.md')) || fs.existsSync(path.join(dir, 'HANDOFF.md'))) {
    add('PASS', 'doc:handoff');
  } else {
    add('WARNING', 'doc:handoff', 'missing', 'Run termux-os-sdk handoff before transferring work.');
  }

  // Self-test.
  if (fs.existsSync(path.join(dir, 'test/self-test.mjs'))) add('PASS', 'self_test_exists');
  else add('FAIL', 'self_test_exists', null, 'Add a fast, isolated test/self-test.mjs.');

  // Current administration contract: one owned menu page and the shared Browser Session.
  if (m) {
    const expectedPath = `/packages/${m.id}/`;
    if ((m.menu ?? []).some((node) => node.path === expectedPath)) add('PASS', 'package_menu_declared');
    else add('FAIL', 'package_menu_declared', expectedPath,
      'Declare the Package-owned WebUI root under the appropriate Core navigation group.');
  }
  const webuiFile = path.join(dir, webui);
  if (fs.existsSync(webuiFile)) {
    const html = fs.readFileSync(webuiFile, 'utf8');
    const webDir = path.dirname(webuiFile);
    let webCode = '';
    try {
      webCode = fs.readdirSync(webDir)
        .filter((name) => ['.js', '.mjs'].includes(path.extname(name)))
        .map((name) => fs.readFileSync(path.join(webDir, name), 'utf8'))
        .join('\n');
    } catch { /* The entry point check already reports an unreadable WebUI. */ }
    const hasSharedSession = html.includes('/admin/session.js') && webCode.includes('window.TermuxOS.api');
    if (hasSharedSession) add('PASS', 'webui_uses_browser_session');
    else add('FAIL', 'webui_uses_browser_session', null,
      'Load /admin/session.js and call same-origin APIs through window.TermuxOS.api.');
    const storesCredential = /\bid=["']token["']|localStorage|sessionStorage|Authorization\s*:\s*['"`]Bearer/i
      .test(`${html}\n${webCode}`);
    if (storesCredential) add('FAIL', 'webui_no_credential_input', null,
      'Remove token fields, browser-stored credentials, and custom Bearer authentication.');
    else add('PASS', 'webui_no_credential_input');
  }

  // Heuristic source scan for unsafe local assumptions.
  const offenders = { devpath: [], ip: [], cred: [], legacyAuth: [], fixedPort: [] };
  for (const rel of codeFiles(dir)) {
    const src = fs.readFileSync(path.join(dir, rel), 'utf8');
    if (/\/(?:home|Users)\/[^/\s"']+\//.test(src) || /[A-Za-z]:\\Users\\/.test(src)) offenders.devpath.push(rel);
    if (/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})/.test(src)) offenders.ip.push(rel);
    if (/(credential|token|password)['"]?\s*[:=]\s*['"][A-Za-z0-9+/]{8,}['"]/.test(src)) offenders.cred.push(rel);
    if (/context\.config\??\.auth\??\.admin_token|\bFRAMEWORK_TOKEN\b/.test(src)) offenders.legacyAuth.push(rel);
    if (/\.listen\(\s*[1-9]\d{3,4}\b/.test(src)) offenders.fixedPort.push(rel);
  }
  if (offenders.devpath.length) add('FAIL', 'no_hardcoded_dev_path', offenders.devpath.join(', '), 'Inject paths through environment variables or Package context.');
  else add('PASS', 'no_hardcoded_dev_path');
  if (offenders.ip.length) add('FAIL', 'no_hardcoded_device_ip', offenders.ip.join(', '), 'Resolve addresses from configuration or a descriptor.');
  else add('PASS', 'no_hardcoded_device_ip');
  if (offenders.cred.length) add('FAIL', 'no_credential_in_source', offenders.cred.join(', '), 'Keep credentials in private persistent state, never source or Release.');
  else add('PASS', 'no_credential_in_source');
  if (offenders.legacyAuth.length) add('FAIL', 'uses_system_key_contract', offenders.legacyAuth.join(', '),
    'Use TERMUX_OS_SYSTEM_KEY in a service or context.auth.systemKey() in in-process code.');
  else add('PASS', 'uses_system_key_contract');
  if (offenders.fixedPort.length) add('FAIL', 'no_hardcoded_http_port', offenders.fixedPort.join(', '),
    'Declare the API in manifest ports and read the assigned PORT or context.ports value.');
  else add('PASS', 'no_hardcoded_http_port');

  // Type-specific checks.
  const types = m?.types ?? [];
  if (types.includes('service') && !(m.components?.services ?? []).length) {
    add('FAIL', 'service_declares_component', null, 'Declare at least one components.services ID.');
  }
  if (types.includes('service')) {
    const serviceSource = [...codeFiles(dir)]
      .filter((rel) => rel.startsWith('service/'))
      .map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8'))
      .join('\n');
    if (serviceSource.includes('process.env.PORT')) {
      if ((m?.ports ?? []).length) add('PASS', 'service_http_port_declared');
      else add('FAIL', 'service_http_port_declared', null,
        'Declare every Package-owned HTTP listener in the manifest ports array.');
    }
  }
  if (types.includes('app')) {
    if (!(m.capabilities?.requires ?? []).length) add('WARNING', 'app_requires_capabilities', 'requires is empty', 'An App normally consumes provider-neutral Capabilities.');
    const appCode = [...codeFiles(dir)].filter((r) => r.startsWith('app/') || r.startsWith('service/'));
    const hard = appCode.filter((r) => {
      const s = fs.readFileSync(path.join(dir, r), 'utf8');
      return /github\.termux-os\.(adapter|service)\./.test(s.replaceAll(id, ''));
    });
    if (hard.length) add('FAIL', 'app_no_hardcoded_provider', hard.join(', '), 'Resolve /api/capabilities/<id> instead of naming a provider Package.');
    else add('PASS', 'app_no_hardcoded_provider');
  }
  if (types.includes('asset')) {
    if ((m.components?.services ?? []).length || (m.components?.actions ?? []).length) {
      add('FAIL', 'asset_no_process', null, 'An asset Package cannot declare a Service or Action.');
    } else add('PASS', 'asset_no_process');
    if (!(m.assets?.provides ?? []).length) add('FAIL', 'asset_declares_provides', null, 'Declare the immutable payload in assets.provides.');
    if (!(m.targets ?? []).length) add('WARNING', 'asset_target', 'generic asset', 'Confirm that a model or optimized asset is intentionally target-independent.');
  }

  return { results, manifest: m };
}

export async function cmdDoctor(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk doctor <package-id>');
  const { results } = await collectDoctor(id);
  const counts = { PASS: 0, WARNING: 0, FAIL: 0 };
  for (const r of results) counts[r.level]++;
  const ok = counts.FAIL === 0;
  emit({ ok, package: id, counts, results,
    ...(ok ? {} : { fix: 'Resolve every FAIL before release.' }) }, flags, () => {
    for (const r of results) {
      const mark = r.level === 'PASS' ? 'PASS   ' : r.level === 'WARNING' ? 'WARN   ' : 'FAIL   ';
      console.log(`${mark}${r.check}${r.detail ? ` — ${r.detail}` : ''}`);
      if (r.fix && r.level !== 'PASS') console.log(`       ↳ ${r.fix}`);
    }
    console.log(`\nPASS=${counts.PASS} WARNING=${counts.WARNING} FAIL=${counts.FAIL}`);
    if (!ok) console.log('Resolve every FAIL before release.');
  });
  if (!ok) process.exit(1);
}

export async function cmdNext(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk next <package-id>');
  const dir = packageDir(id);
  if (!fs.existsSync(dir)) {
    return fail(flags, 'package_not_found', dir, `termux-os-sdk new --id ${id} --type <type> --name "<Name>"`);
  }
  const { results } = await collectDoctor(id);
  const completed = results.filter((r) => r.level === 'PASS').map((r) => r.check);
  const missing = results.filter((r) => r.level !== 'PASS').map((r) => `${r.check}${r.detail ? ` (${r.detail})` : ''}`);
  let proj = null;
  for (const rel of ['.sdk/project.v1.json', 'sdk-project.v1.json']) {
    try { proj = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); break; } catch { /* Optional metadata. */ }
  }

  const hasFail = results.some((r) => r.level === 'FAIL');
  const phase = hasFail ? 'implementation' : 'ready_for_release';
  const next = hasFail
    ? ['Resolve the doctor FAIL items', `termux-os-sdk test ${id}`, `termux-os-sdk doctor ${id}`]
    : [`termux-os-sdk release ${id}`, 'termux-os-sdk install <tar> (add --connection for another device)',
      `termux-os-sdk verify-device ${id}`, `termux-os-sdk handoff ${id}`, 'Commit according to the Package repository rules'];

  emit({ ok: true, package: id, phase, current_section: proj?.development?.current_section ?? null,
    completed, missing, next }, flags, (o) => {
    console.log(`Current phase: ${o.phase}${o.current_section !== null ? ` (Section ${o.current_section})` : ''}\n`);
    console.log(`Completed:\n${o.completed.map((c) => `  ${c}`).join('\n') || '  -'}\n`);
    console.log(`Missing:\n${o.missing.map((c) => `  ${c}`).join('\n') || '  none'}\n`);
    console.log(`Next:\n${o.next.map((c) => `  ${c}`).join('\n')}`);
  });
}
