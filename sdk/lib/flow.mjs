/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/flow.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FW_ROOT, emit, fail, frameworkToken, packageDir, readManifest, run, sdkMetaDir } from './util.mjs';
import { collectDoctor } from './doctor.mjs';
import { resolveConnection, frameworkFetch, transportPut, transportExec } from './connection.mjs';
import { hashWorkspace } from '../../src/packages/workspace-hash.mjs';

const stage = (name) => console.log(`\n== ${name} ==`);

// Test only the selected Package.
export async function cmdTest(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk test <package-id>');
  const dir = packageDir(id);
  if (!fs.existsSync(dir)) return fail(flags, 'package_not_found', dir, 'Run termux-os-sdk context to list source workspaces.');
  const steps = [];
  const record = (step, ok, detail) => steps.push({ step, ok, ...(detail ? { detail } : {}) });

  stage('self-test');
  if (fs.existsSync(path.join(dir, 'test/self-test.mjs'))) {
    record('self-test', run('node', ['test/self-test.mjs'], { cwd: dir }) === 0);
  } else record('self-test', false, 'test/self-test.mjs is missing');

  stage('smoke');
  if (fs.existsSync(path.join(dir, 'scripts/smoke.sh'))) {
    record('smoke', run('bash', ['scripts/smoke.sh'], { cwd: dir }) === 0);
  } else record('smoke', true, 'No smoke.sh; skipped.');

  stage('doctor');
  const { results } = await collectDoctor(id);
  const fails = results.filter((r) => r.level === 'FAIL');
  record('doctor', fails.length === 0, fails.length ? `${fails.length} FAIL` : undefined);

  const ok = steps.every((s) => s.ok);
  emit({ ok, package: id, steps,
    ...(ok ? { next: `termux-os-sdk release ${id}` }
      : { fix: `Inspect the failed stage above; run termux-os-sdk doctor ${id} for details.` }) },
  flags, (o) => {
    console.log(`\n${o.ok ? '✓ Tests passed' : '✗ Tests failed'}: ${o.steps.map((s) => `${s.step}=${s.ok ? 'ok' : 'FAIL'}`).join('  ')}`);
    if (o.next) console.log(`Next: ${o.next}`);
    if (o.fix) console.log(`Next: ${o.fix}`);
  });
  if (!ok) process.exit(1);
}

// Release delegates doctor, pack, and verify to their canonical implementations.
export async function cmdRelease(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk release <package-id> [--target <target>] [--artifact-dir <dir>]');
  const dir = packageDir(id);
  if (!fs.existsSync(dir)) return fail(flags, 'package_not_found', dir, 'Run termux-os-sdk context.');

  stage('doctor');
  const { results } = await collectDoctor(id);
  const fails = results.filter((r) => r.level === 'FAIL');
  if (fails.length) {
    return fail(flags, 'doctor_failed', fails.map((f) => f.check).join(', '),
      `Run termux-os-sdk doctor ${id} and resolve every FAIL.`);
  }
  console.log('doctor: 0 FAIL');

  stage('package self-test');
  if (fs.existsSync(path.join(dir, 'test/self-test.mjs'))
    && run('node', ['test/self-test.mjs'], { cwd: dir }) !== 0) {
      return fail(flags, 'self_test_failed', null, `Run node ${path.relative(FW_ROOT, dir)}/test/self-test.mjs to inspect failures.`);
  }

  /**
   * ⭐ 本地 release 與 GitHub CI 用同一個 builder。
   *
   * 此前本地走 `package-manager pack`（確定性歸檔、**不帶 .git**），CI 走 shallow-Git
   * asset：兩條路產出的東西不是同一種包，於是「解包即用、Git 即狀態」在本地包上
   * 直接不成立。現在只有一個規格。
   */
  const m = readManifest(dir);
  const target = flags.target ? String(flags.target) : null;
  const outDir = flags['artifact-dir']
    ? path.resolve(String(flags['artifact-dir']))
    : path.join(FW_ROOT, 'dist/releases', id, m.version);

  stage('shallow-Git package asset');
  const buildArgs = [path.join(FW_ROOT, 'scripts/build-package-asset.sh'), '--source', dir, '--out-dir', outDir];
  // 正式 release 要求來源乾淨；dirty 產物必須顯式索取，且仍是同一種包——
  // 裝上去自然判為 dev，而不是變成另一個 package type。
  if (flags['allow-dirty']) buildArgs.push('--allow-dirty');
  if (flags.branch) buildArgs.push('--branch', String(flags.branch));
  if (run('bash', buildArgs) !== 0) {
    return fail(flags, 'asset_build_failed', null,
      'Commit the work tree, or pass --allow-dirty for a local development artifact.');
  }

  const tarName = `${id}-${m.version}.tar.gz`;
  const tar = path.join(outDir, tarName);
  const sha = fs.existsSync(`${tar}.sha256`) ? fs.readFileSync(`${tar}.sha256`, 'utf8').split(/\s+/)[0] : null;

  stage('package-manager verify');
  if (run('node', ['scripts/package-manager.mjs', 'verify', tar]) !== 0) {
    return fail(flags, 'verify_failed', tar, 'The new archive failed Core verification; report an SDK/pack inconsistency.');
  }

  // Source hash is development metadata and does not enter the archive.
  fs.writeFileSync(`${tar}.source-hash`, `${hashWorkspace(dir)}\n`);

  // Emit an absolute release path so the next command is unambiguous.
  emit({ ok: true, package: id, version: m.version, target: target ?? 'generic',
    release: tar, sha256: sha,
    install: `termux-os-sdk install ${tar}`,
    install_with_connection: `termux-os-sdk install ${tar} --connection <name>` },
  flags, (o) => {
    console.log('\n✓ Release ready');
    console.log(`  Package : ${o.package} ${o.version} [${o.target}]`);
    console.log(`  Tar     : ${o.release}`);
    console.log(`  SHA-256 : ${o.sha256}`);
    console.log(`  Install locally:\n    ${o.install}`);
    console.log(`  Install through a connection:\n    ${o.install_with_connection}`);
  });
}

// Install through the selected connection; local is the default.

/** Resolve the target Framework runtime root. */
function runtimeRoot(conn) {
  if (conn.transport.framework_root) return conn.transport.framework_root;
  if (conn.transport.type === 'local') {
    const installed = path.join(os.homedir(), '.termux-os/framework');
    return fs.existsSync(installed) ? installed : FW_ROOT;
  }
  return '~/.termux-os/framework';
}

/** Resolve relative release paths from the current directory, then Framework root. */
function resolveTar(tar, flags) {
  if (path.isAbsolute(tar)) {
    if (fs.existsSync(tar)) return tar;
    return fail(flags, 'tar_not_found', tar, 'Run termux-os-sdk release <package-id> and use its absolute install command.');
  }
  const tries = [path.resolve(process.cwd(), tar), path.resolve(FW_ROOT, tar)];
  const hit = tries.find((p) => fs.existsSync(p));
  if (hit) return hit;
  return fail(flags, 'tar_not_found', `Tried:\n  ${tries.join('\n  ')}`,
    'Use the absolute path emitted by termux-os-sdk release.');
}

export async function cmdInstall(flags, pos) {
  const tar = pos[0];
  if (!tar) {
    return fail(flags, 'missing_args', null,
      'Usage: termux-os-sdk install <release.tar.gz> [--connection <name>|--remote <ssh-host>].');
  }
  const conn = resolveConnection(flags);
  const tarAbs = resolveTar(tar, flags);
  const base = path.basename(tarAbs);
  const root = runtimeRoot(conn);
  const where = conn.name ?? conn.transport.host ?? conn.source;

  // Local installation needs no transfer; other transports stage the files first.
  let devicePath = tarAbs;
  if (conn.transport.type !== 'local') {
    stage(`transfer → ${where}`);
    if (transportPut(conn, tarAbs, `~/${base}`, flags) !== 0
      || transportPut(conn, `${tarAbs}.sha256`, `~/${base}.sha256`, flags) !== 0) {
        return fail(flags, 'transfer_failed', null, `Verify the transport for connection "${where}".`);
    }
    devicePath = `~/${base}`;
  }

  stage('package-manager check');
  if (transportExec(conn, `cd ${root} && node scripts/package-manager.mjs check ${devicePath}`, flags) !== 0) {
    return fail(flags, 'device_check_failed', null,
      'Resolve the reported target or external requirement; do not bypass preflight.');
  }

  stage('package-manager install');
  if (transportExec(conn, `cd ${root} && node scripts/package-manager.mjs install ${devicePath}`, flags) !== 0) {
    return fail(flags, 'install_failed', null, 'Inspect the installer output. The previous active version was restored automatically.');
  }

  stage('check-installed');
  const idGuess = base.replace(/-\d+\.\d+\.\d+.*$/, '');
  transportExec(conn, `cd ${root} && node scripts/package-manager.mjs check-installed ${idGuess}`, flags);

  // Query runtime truth after installation instead of reporting only process completion.
  stage('runtime truth');
  const truth = await installedTruth(conn, idGuess);
  const connArg = conn.source === 'default-local' ? '' : (conn.name ? ` --connection ${conn.name}` : ` --remote ${conn.transport.host}`);
  emit({ ok: true, tar: base, connection: where, package: idGuess, ...truth,
    next: `termux-os-sdk verify-device ${idGuess}${connArg}; then termux-os-sdk handoff ${idGuess}` },
  flags, (o) => {
    console.log(`\n✓ Installed ${o.package} → ${o.connection}`);
    console.log(`  installed : ${o.installed_version ?? 'unknown'} (sha ${String(o.installed_sha256 ?? 'unknown').slice(0, 12)}…, target ${o.target ?? 'generic'})`);
    console.log(`  service   : desired=${o.desired ?? 'n/a'} process=${o.process ?? 'n/a'} health=${o.health ?? 'n/a'}`);
    if (o.package_url) console.log(`  URL       : ${o.package_url}`);
    console.log(`Next: ${o.next}`);
  });
}

/** Query installed truth over HTTP; unreachable fields remain unknown. */
async function installedTruth(conn, pkgId) {
  const out = {};
  const token = frameworkToken();
  let svcIds = [];
  const p = await frameworkFetch(conn, `/api/packages/${pkgId}`, { token });
  if (p.ok && p.data?.package) {
    out.installed_version = p.data.package.install?.version ?? p.data.package.manifest?.version ?? null;
    out.installed_sha256 = p.data.package.install?.archive_sha256 ?? null;
    out.target = p.data.package.manifest?.targets?.[0]?.id ?? 'generic';
    svcIds = p.data.package.manifest?.components?.services ?? [];
  }
  const s = await frameworkFetch(conn, '/api/stage/services', { token });
  if (s.ok && s.data?.services) {
    const svc = s.data.services.find((x) => svcIds.includes(x.id));
    if (svc) { out.desired = svc.desired ?? null; out.process = svc.process?.state ?? null; out.health = svc.health?.state ?? null; }
  }
  const a = await frameworkFetch(conn, '/api/access-info');
  const lan = a.ok ? (a.data?.addresses ?? []).find((x) => x.kind === 'lan')?.admin_url?.replace(/\/admin$/, '') : null;
  const base = conn.framework_url ?? lan;
  if (base) out.package_url = `${base}/packages/${pkgId}/`;
  return out;
}

// Handoff contains only current facts.
export async function cmdHandoff(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk handoff <package-id>');
  const dir = packageDir(id);
  if (!fs.existsSync(dir)) return fail(flags, 'package_not_found', dir, null);
  const m = readManifest(dir);
  const { results } = await collectDoctor(id);
  const fails = results.filter((r) => r.level === 'FAIL').map((r) => r.check);
  const warns = results.filter((r) => r.level === 'WARNING').map((r) => r.check);
  let proj = null;
  // Development state belongs under .sdk/ and outside Release archives.
  for (const p of [path.join(sdkMetaDir(dir), 'project.v1.json'), path.join(dir, 'sdk-project.v1.json')]) {
    try { proj = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch { /* Optional metadata. */ }
  }

  const content = `# Handoff — ${id}

This file contains current facts only. A maintainer should be able to start with the commands below.

- Version: ${m.version} (types: ${m.types.join(',')})
- User entry: /packages/${id}/
- Doctor: ${fails.length ? `FAIL=${fails.join(', ')}` : '0 FAIL'}${warns.length ? `; WARNING=${warns.join(', ')}` : ''}
- Test: \`termux-os-sdk test ${id}\`
- Release: \`termux-os-sdk release ${id}\`
- Known issues and remaining work: TODO

Generated at: ${new Date().toISOString()}
`;
  // Mutable handoff state stays under .sdk/ and outside the immutable archive.
  const metaDir = sdkMetaDir(dir);
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'handoff.md'), content);
  emit({ ok: true, package: id, handoff: path.join(sdkMetaDir(dir), 'handoff.md') }, flags,
    (o) => console.log(`✓ Wrote ${o.handoff}; complete the known-issues section before handoff.`));
}
