/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/verify.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { emit, fail, frameworkToken, packageDir, readManifest, sdkMetaDir } from './util.mjs';
import { resolveConnection, frameworkFetch, transportExec } from './connection.mjs';

const TOKEN = frameworkToken();
const RESULTS = new Set(['pass', 'degraded', 'skip', 'fail']);

/** Parse the final valid result object while allowing preceding diagnostic logs. */
function parseHookOutput(stdout) {
  const lines = String(stdout).trim().split('\n').reverse();
  for (const l of lines) {
    if (!l.trim().startsWith('{')) continue;
    try {
      const d = JSON.parse(l);
      if (d.schema === 'termux-os.device-verify.v1' && RESULTS.has(d.result)) return d;
    } catch { /* Continue searching earlier lines. */ }
  }
  return null;
}

export async function cmdVerifyDevice(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk verify-device <package-id> [--connection <name>] [--dev]');
  const conn = resolveConnection(flags);
  const wsDir = packageDir(id);

  // Dev mode runs the selected source repository and does not bind Release evidence.
  if (flags.dev) {
    let m;
    try { m = readManifest(wsDir); } catch { return fail(flags, 'source_not_found', wsDir, null); }
    const decl = m.verification?.device;
    if (!decl) return fail(flags, 'no_verify_hook', 'Manifest does not declare verification.device', 'Add verification.device.command to the manifest.');
    const r = runHook(conn, wsDir, decl, flags);
    return report(flags, { id, mode: 'dev', hook: r, binding: null, wsDir });
  }

  // Installed mode binds the exact Package, target, SHA-256, and Framework build.
  const p = await frameworkFetch(conn, `/api/packages/${id}`, { token: TOKEN });
  if (!p.ok) return fail(flags, 'framework_unreachable', p.error, 'Start Framework and retry.');
  if (p.status === 404 || !p.data?.package) return fail(flags, 'not_installed', id, 'Release and install the Package, or use --dev for source-repository iteration.');
  const pk = p.data.package;
  const dev = await frameworkFetch(conn, `/api/dev/packages/${id}/status`, { token: TOKEN });
  if (dev.ok && ['dev', 'conflicted'].includes(dev.data?.reconcile?.state)) {
    return fail(flags, 'dev_active', `${id} active worktree is ${dev.data.reconcile.state}; installed verification cannot bind Release evidence.`,
      `Restore/reconcile ${id}, or use termux-os-sdk verify-device ${id} --dev for source-repository evidence.`);
  }
  const decl = pk.manifest?.verification?.device;
  if (!decl) {
    return report(flags, { id, mode: 'installed',
      hook: { parsed: { schema: 'termux-os.device-verify.v1', result: 'skip', checks: [] }, note: 'Package declares no verification.device hook; result is skip, never an invented pass.' },
      binding: await binding(conn, pk), wsDir });
  }

  if (decl.requires_running) {
    const svcIds = pk.manifest?.components?.services ?? [];
    const s = await frameworkFetch(conn, '/api/stage/services', { token: TOKEN });
    const running = (s.data?.services ?? []).some((x) => svcIds.includes(x.id) && x.process?.state === 'running');
    if (!running) {
      return fail(flags, 'requires_running_not_met', `The hook requires a running Service, but ${svcIds.join(',') || 'none'} is running.`,
        'Start the Service from Administration / Services or the Stage API, then retry.');
    }
  }

  const r = runHook(conn, pk.dir, decl, flags);
  return report(flags, { id, mode: 'installed', hook: r, binding: await binding(conn, pk), wsDir });
}

function runHook(conn, cwd, decl, flags) {
  const timeoutS = Math.ceil((decl.timeout_ms ?? 30000) / 1000);
  const cmd = `cd ${cwd} && timeout ${timeoutS} ${decl.command}`;
  console.log(`== device verify hook ==\n$ ${cmd}\n`);
  const token = frameworkToken() ?? '';
  let targetFrameworkUrl = 'http://127.0.0.1:8980';
  try {
    const parsed = new URL(conn.framework_url);
    targetFrameworkUrl = `http://127.0.0.1:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`;
  } catch { /* SSH-only connections use the default target loopback URL. */ }
  const r = transportExec(conn, cmd, flags, {
    capture: true,
    env: {
      TERMUX_OS_TOKEN: token,
      TERMUX_OS_SYSTEM_KEY: token,
      TERMUX_OS_FRAMEWORK_URL: targetFrameworkUrl,
    },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const parsed = parseHookOutput(r.stdout);
  if (!parsed) {
    return { parsed: { schema: 'termux-os.device-verify.v1', result: 'fail', checks: [] },
      note: r.status === 124 ? `hook timed out after ${timeoutS}s` : 'Hook emitted no valid termux-os.device-verify.v1 result; treated as fail.' };
  }
  return { parsed, note: null };
}

async function binding(conn, pk) {
  let fb = 'unknown';
  const ai = await frameworkFetch(conn, '/api/access-info');
  if (ai.ok && ai.data?.ok) fb = ai.data.git_commit ?? 'unknown';
  return {
    package_id: pk.id,
    version: pk.install?.version ?? pk.manifest?.version ?? null,
    target: pk.manifest?.targets?.[0]?.id ?? 'generic',
    release_sha256: pk.install?.archive_sha256 ?? null,
    framework_build: fb,
  };
}

function report(flags, { id, mode, hook, binding: b, wsDir }) {
  const d = hook.parsed;
  const rec = { schema: 'termux-os.device-verify-record.v1', mode, result: d.result,
    checks: d.checks ?? [], at: new Date().toISOString(), ...(b ?? {}), ...(hook.note ? { note: hook.note } : {}) };
  // Verification records are mutable source-repository evidence and stay outside Release archives.
  if (fs.existsSync(wsDir)) {
    const metaDir = sdkMetaDir(wsDir);
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, `verify${mode === 'dev' ? '-dev' : ''}.v1.json`), JSON.stringify(rec, null, 2));
  }
  emit({ ok: d.result !== 'fail', package: id, mode, result: d.result, checks: d.checks ?? [],
    ...(b ? { binding: b } : {}), ...(hook.note ? { note: hook.note } : {}) }, flags, (o) => {
    console.log(`\n== device verify (${o.mode}) ==`);
    for (const c of o.checks) console.log(`  ${c.result.padEnd(8)} ${c.id}${c.evidence ? ` — ${c.evidence}` : ''}`);
    if (o.note) console.log(`  note: ${o.note}`);
    console.log(`Result: ${o.result}`);
    if (o.binding) console.log(`Binding: ${o.binding.package_id} ${o.binding.version} [${o.binding.target}] sha ${String(o.binding.release_sha256 ?? 'unknown').slice(0, 12)}… fw ${o.binding.framework_build}`);
  });
  if (d.result === 'fail') process.exit(1);
}
