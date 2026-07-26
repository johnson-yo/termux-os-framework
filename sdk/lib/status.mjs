/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/status.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FW_ROOT, emit, fail, frameworkToken, packageDir, readManifest } from './util.mjs';
import { resolveConnection, frameworkFetch } from './connection.mjs';
import { hashWorkspace } from '../../src/packages/workspace-hash.mjs';

const TOKEN = frameworkToken();
const semverCmp = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0); }
  return 0;
};

/** Return the highest local Release version and all of its target artifacts. */
function lastRelease(id) {
  const root = path.join(FW_ROOT, 'dist/releases', id);
  let versions = [];
  try { versions = fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+/.test(v)); } catch { return null; }
  if (!versions.length) return null;
  const v = versions.sort(semverCmp).pop();
  const dir = path.join(root, v);
  const tars = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz'));
  const artifacts = tars.map((t) => {
    const target = t.replace(`${id}-${v}`, '').replace(/^-/, '').replace(/\.tar\.gz$/, '') || 'generic';
    const sha = (() => { try { return fs.readFileSync(path.join(dir, `${t}.sha256`), 'utf8').split(/\s+/)[0]; } catch { return null; } })();
    const srcHash = (() => { try { return fs.readFileSync(path.join(dir, `${t}.source-hash`), 'utf8').trim(); } catch { return null; } })();
    return { tar: path.join(dir, t), target, sha256: sha, source_hash: srcHash };
  });
  return { version: v, artifacts };
}

export async function cmdStatus(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk status <package-id> [--connection <name>|--framework-url <url>]');
  const conn = resolveConnection(flags);

  // Workspace.
  const wsDir = packageDir(id);
  let workspace = null;
  if (fs.existsSync(path.join(wsDir, 'termux-os.package.json'))) {
    let version = null;
    try { version = readManifest(wsDir).version; } catch { /* Keep the Workspace visible even with a broken manifest. */ }
    workspace = { dir: wsDir, version, content: hashWorkspace(wsDir) };
  }

  // Last Release.
  const release = lastRelease(id);

  // Dev, Installed, Running, and Verify truth from HTTP.
  let reachable = false;
  let dev = null; let installed = null; let running = null;
  const dm = await frameworkFetch(conn, '/api/dev/packages', { token: TOKEN });
  if (dm.ok) {
    reachable = true;
    const m = (dm.data?.mounts ?? []).find((x) => x.package_id === id);
    if (m) dev = { active: true, source: m.workspace, data: m.data_mode, source_hash: m.source_hash, shadow: m.shadow };
  }
  const p = await frameworkFetch(conn, `/api/packages/${id}`, { token: TOKEN });
  if (p.ok && p.data?.package) {
    const pk = p.data.package;
    // A Dev record shadows, but does not mutate, the Installed identity.
    if (pk.source === 'dev-mount' && pk.dev?.shadow) {
      installed = { version: pk.dev.shadow.version, sha256: pk.dev.shadow.sha256 ?? null, target: null };
    } else if (pk.source === 'installed' || pk.install) {
      installed = { version: pk.install?.version ?? pk.manifest?.version ?? null,
        sha256: pk.install?.archive_sha256 ?? null,
        target: pk.manifest?.targets?.[0]?.id ?? 'generic' };
    }
    const svcIds = pk.manifest?.components?.services ?? [];
    const s = await frameworkFetch(conn, '/api/stage/services', { token: TOKEN });
    const svc = (s.data?.services ?? []).find((x) => svcIds.includes(x.id));
    if (svc) running = { desired: svc.desired, process: svc.process?.state ?? 'unknown', health: svc.health?.state ?? 'unknown' };
  } else if (p.ok && p.status === 404 && dev == null) {
    installed = null; // Confirmed absent.
  }
  // Device Verify record stored in Workspace development state.
  let verify = null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(wsDir, '.sdk/verify.v1.json'), 'utf8'));
    verify = { result: v.result, at: v.at, release_sha256: v.release_sha256 ?? null, mode: v.mode ?? 'installed' };
  } catch { /* No recorded Device Verify result. */ }

  // Framework build.
  let frameworkBuild = 'unknown';
  const ai = await frameworkFetch(conn, '/api/access-info');
  if (ai.ok && ai.data?.ok) frameworkBuild = ai.data.git_commit ?? ai.data.deploy_id ?? 'unknown';

  // Drift remains unknown when target truth is unreachable.
  const drift = [];
  if (!reachable) drift.push('unknown');
  if (dev && installed) drift.push('dev-shadowing-installed');
  const relArt = release?.artifacts?.[0] ?? null;
  if (workspace && release && relArt?.source_hash && relArt.source_hash !== workspace.content) drift.push('workspace-ahead');
  if (workspace && !release) drift.push('workspace-ahead');
  if (reachable && release && !installed && !dev) drift.push('release-not-installed');
  if (reachable && release && installed && relArt?.sha256 && installed.sha256 && relArt.sha256 !== installed.sha256) drift.push('installed-behind');
  if (verify && installed?.sha256 && verify.release_sha256 && verify.release_sha256 !== installed.sha256) drift.push('verify-stale');
  if (!drift.length) drift.push('clean');

  const out = { ok: true, package: id, connection: conn.name ?? conn.source, reachable,
    framework_build: frameworkBuild,
    workspace: workspace ?? null, dev_runtime: dev ?? { active: false },
    last_release: release ? { version: release.version, ...relArt } : null,
    installed, running, device_verify: verify, drift };

  emit(out, flags, (o) => {
    const line = (k, v) => console.log(`  ${k}: ${v ?? 'unknown'}`);
    console.log(`Package: ${o.package}  Connection: ${o.connection}${o.reachable ? '' : ' (Framework unreachable; target state is unknown)'}`);
    console.log(`Framework build: ${o.framework_build}\n`);
    console.log('Workspace');
    if (o.workspace) { line('version', o.workspace.version); line('content', `${o.workspace.content.slice(0, 12)}…`); }
    else console.log('  no local Workspace');
    console.log('\nDev Runtime');
    line('active', o.dev_runtime.active);
    if (o.dev_runtime.active) { line('source', o.dev_runtime.source); line('data', o.dev_runtime.data); }
    console.log('\nLast Release');
    if (o.last_release) { line('version', o.last_release.version); line('target', o.last_release.target); line('sha256', `${o.last_release.sha256?.slice(0, 12)}…`); }
    else console.log('  none');
    console.log('\nInstalled');
    if (o.installed) { line('version', o.installed.version); line('target', o.installed.target); line('sha256', `${String(o.installed.sha256 ?? 'unknown').slice(0, 12)}…`); }
    else console.log(o.reachable ? '  not installed' : '  unknown');
    console.log('\nRunning');
    if (o.running) { line('desired', o.running.desired); line('process', o.running.process); line('health', o.running.health); }
    else console.log(o.reachable ? '  no registered Stage Service' : '  unknown');
    console.log('\nDevice Verify');
    if (o.device_verify) { line('result', o.device_verify.result); line('release', `${String(o.device_verify.release_sha256 ?? 'unbound').slice(0, 12)}…`); }
    else console.log('  not run');
    console.log(`\nDrift\n  ${o.drift.join('\n  ')}`);
  });
}
