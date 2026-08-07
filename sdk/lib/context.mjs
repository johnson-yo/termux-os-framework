/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/context.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FW_ROOT, PKGS_DIR, emit, fail, listSourcePackages, packageDir, readManifest, runCapture, sdkMetaDir } from './util.mjs';

const CORE_CONCEPTS = [
  'Capability', 'Action', 'Feed', 'State', 'Stage Service',
  'Package Port', 'System Key', 'Browser Session',
];
const PACKAGE_TYPES = ['app', 'service', 'adapter', 'asset'];

function scanProviders() {
  const providers = [];
  const targets = new Set(['generic']);
  for (const p of listSourcePackages()) {
    for (const cap of p.manifest.capabilities?.provides ?? []) providers.push(cap.id);
    for (const t of p.manifest.targets ?? []) targets.add(t.id);
  }
  return { providers: [...new Set(providers)].sort(), targets: [...targets] };
}

export function cmdContext(flags) {
  const { providers, targets } = scanProviders();
  const ctx = {
    ok: true,
    framework_root: FW_ROOT,
    package_source: 'current Package repository or ~/termux-os-dev/packages/<package-id>/',
    installed_root: '~/.termux-os/packages/<package-id>/',
    persistent_root: '/sdcard/termux-os/framework/',
    package_types: PACKAGE_TYPES,
    core_concepts: CORE_CONCEPTS,
    current_providers: providers,
    current_targets: targets,
    source_packages: listSourcePackages().map((p) => `${p.id} ${p.manifest.version}`),
    docs: {
      start_here: 'sdk/START_HERE.md',
      agent_prompt: 'sdk/AI_AGENT_PROMPT.md',
      architecture: 'sdk/ARCHITECTURE.md',
      contracts: 'sdk/CONTRACTS.md',
      ports: 'docs/PACKAGE_PORTS.md',
      types: 'sdk/PACKAGE_TYPES.md',
    },
  };
  if (flags.remote) Object.assign(ctx, remoteContext(String(flags.remote)));
  emit(ctx, flags, (c) => {
    console.log('Termux-OS SDK Context\n');
    console.log(`Framework root:\n  ${c.framework_root}\n`);
    console.log(`Package source:\n  ${c.package_source}\nInstalled root:\n  ${c.installed_root}\nPersistent config/data:\n  ${c.persistent_root}\n`);
    console.log(`Package types:\n${c.package_types.map((t) => `  ${t}`).join('\n')}\n`);
    console.log(`Core concepts:\n${c.core_concepts.map((t) => `  ${t}`).join('\n')}\n`);
    console.log(`Current providers:\n${c.current_providers.map((t) => `  ${t}`).join('\n')}\n`);
    console.log(`Current targets:\n${c.current_targets.map((t) => `  ${t}`).join('\n')}\n`);
    console.log(`Source packages:\n${c.source_packages.map((t) => `  ${t}`).join('\n')}`);
    if (c.remote) {
      const r = c.remote;
      console.log(`\nRemote ${r.host}:`);
      console.log(`  health: ${r.health}　framework: ${r.framework_version ?? 'unknown'}　build: ${r.build ?? 'unknown'}`);
      console.log(`  admin: ${r.admin_url ?? 'unknown'}`);
      console.log(`  device profile: ${r.device_profile ?? 'unknown'}`);
      console.log(`  installed:\n${(r.installed ?? ['unknown']).map((x) => `    ${x}`).join('\n')}`);
    }
  });
}

function remoteContext(host) {
  const remote = { host, health: 'unknown', installed: null, device_profile: 'unknown' };
  const ai = runCapture('ssh', [host, 'curl -s -m 5 http://127.0.0.1:8980/api/access-info']);
  try {
    const d = JSON.parse(ai.stdout);
    remote.health = d.health ?? 'unknown';
    remote.framework_version = d.version ?? 'unknown';
    remote.build = d.git_commit ?? 'unknown';
    remote.admin_url = (d.addresses ?? []).find((a) => a.kind === 'lan')?.admin_url ?? d.primary?.admin_url ?? 'unknown';
  } catch { remote.health = 'unreachable'; }
  const ls = runCapture('ssh', [host, 'cd ~/.termux-os/framework && node scripts/package-manager.mjs list 2>/dev/null']);
  if (ls.status === 0) remote.installed = ls.stdout.trim().split('\n').filter(Boolean);
  const pf = runCapture('ssh', [host, 'cd ~/.termux-os/framework && node scripts/package-manager.mjs profile 2>/dev/null']);
  if (pf.status === 0) {
    try {
      const p = JSON.parse(pf.stdout);
      remote.device_profile = `${p.os}/${p.arch} htp=${p.htp ?? 'unknown'} qnn=${p.qnn ?? 'unknown'}`;
    } catch { /* Keep unknown when profile output is not JSON. */ }
  }
  return { remote };
}

export function cmdInspect(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk inspect <package-id>');
  const dir = packageDir(id);
  if (!fs.existsSync(dir)) {
    return fail(flags, 'package_not_found', `${id} was not found in the current repository or development root`,
      `List source workspaces with: termux-os-sdk context; create one with: termux-os-sdk new --type <type> --id ${id} --name "<Name>"`);
  }
  let m;
  try { m = readManifest(dir); } catch (e) {
    return fail(flags, 'manifest_unreadable', String(e.message), 'Make termux-os.package.json valid JSON.');
  }
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  const info = {
    ok: true,
    id: m.id,
    name: m.name,
    version: m.version,
    types: m.types,
    services: m.components?.services ?? [],
    actions: m.components?.actions ?? [],
    apps: m.components?.apps ?? [],
    provides: (m.capabilities?.provides ?? []).map((c) => `${c.id} (${c.kind})`),
    requires: (m.capabilities?.requires ?? []).map((c) => c.id ?? c),
    targets: (m.targets ?? []).map((t) => t.id),
    runtime_bundled: (m.runtime?.bundled ?? []).length,
    runtime_external: (m.runtime?.external ?? []).map((e) => e.id),
    ports: (m.ports ?? []).map((port) => port.id),
    menu: (m.menu ?? []).map((node) => `${node.parent} → ${node.path}`),
    webui: has(m.entrypoints?.webui ?? 'web/index.html'),
    files: { readme: has('README.md'), handoff: fs.existsSync(path.join(sdkMetaDir(dir), 'handoff.md')) || has('HANDOFF.md'), agents: has('AGENTS.md'),
      self_test: has('test/self-test.mjs'), sdk_project: fs.existsSync(path.join(sdkMetaDir(dir), 'project.v1.json')) || has('sdk-project.v1.json') },
    dir,
  };
  emit(info, flags, (i) => {
    console.log(`${i.id} ${i.version} (${i.types.join(', ')}) — ${i.name}`);
    console.log(`  services: ${i.services.join(', ') || '-'}  actions: ${i.actions.join(', ') || '-'}`);
    console.log(`  provides: ${i.provides.join(', ') || '-'}`);
    console.log(`  requires: ${i.requires.join(', ') || '-'}`);
    console.log(`  targets: ${i.targets.join(', ') || 'generic'}  bundled: ${i.runtime_bundled}  external: ${i.runtime_external.join(', ') || '-'}`);
    console.log(`  ports: ${i.ports.join(', ') || '-'}  menu: ${i.menu.join(', ') || '-'}`);
    console.log(`  webui: ${i.webui ? '✓' : '✗'}`);
    console.log(`  README ${i.files.readme ? '✓' : '✗'}  HANDOFF ${i.files.handoff ? '✓' : '✗'}  AGENTS ${i.files.agents ? '✓' : '✗'}  self-test ${i.files.self_test ? '✓' : '✗'}`);
  });
}

/**
 * Choose the smallest Package type from five non-interactive questions.
 */
export function cmdChoose(flags) {
  const yn = (k) => (flags[k] === undefined ? null : ['yes', 'y', 'true', true].includes(flags[k]));
  const answers = {
    integrates_external: yn('integrates-external'),
    long_running: yn('long-running'),
    combines_capabilities: yn('combines-capabilities'),
    data_only: yn('data-only'),
    extends_existing: yn('extends-existing'),
  };
  if (Object.values(answers).some((v) => v === null)) {
    if (flags.json) return fail(flags, 'missing_answers', 'All five questions require yes or no.',
      'Example: choose --extends-existing no --data-only no --integrates-external no --long-running yes --combines-capabilities no --json');
    console.log(`Package type questions (answer every flag with yes or no):

  --extends-existing        Does this change belong in an existing Package?
                            yes → modify that Package; do not create another one
  --data-only               Is it immutable data with no process? → asset
  --integrates-external     Does it bridge an app, device, engine, or API? → adapter
  --long-running            Does it own a process, state, queue, or feed? → service
  --combines-capabilities   Does it combine Capabilities into a workflow? → app

Add --json for a machine-readable decision. See sdk/PACKAGE_TYPES.md.`);
    return;
  }
  let type = null; let reason = '';
  if (answers.extends_existing) { type = 'none'; reason = 'The requirement extends an existing Package; modify it instead of creating another Package.'; }
  else if (answers.data_only) { type = 'asset'; reason = 'Immutable data with no process belongs in an asset Package.'; }
  else if (answers.integrates_external) { type = 'adapter'; reason = 'A replaceable bridge to an external capability belongs in an adapter Package.'; }
  else if (answers.long_running) { type = 'service'; reason = 'A long-running process, state owner, queue, or feed belongs in a service Package.'; }
  else if (answers.combines_capabilities) { type = 'app'; reason = 'A provider-neutral user workflow belongs in an app Package.'; }
  else { type = 'unclear'; reason = 'The requirement does not yet identify an extension responsibility. Clarify it before creating source.'; }
  const out = { ok: type !== 'unclear', type, reason, answers,
    ...(type !== 'none' && type !== 'unclear'
      ? { next: `termux-os-sdk new --type ${type} --id github.termux-os.${type}.<name> --name "<Name>"` }
      : {}) };
  emit(out, flags, (o) => {
    console.log(`Type: ${o.type}\nReason: ${o.reason}`);
    if (o.next) console.log(`Next: ${o.next}`);
  });
  if (type === 'unclear') process.exit(1);
}
