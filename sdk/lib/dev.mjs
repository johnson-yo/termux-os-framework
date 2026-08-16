/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Framework connection and a Package source repository or ID.
 * [OUTPUT]: Dev watcher commands plus atomic host-source to device-active sync.
 * [POS]: sdk/lib/dev.mjs in termux-os-framework.
 * [PROTOCOL]: Dev always targets the one installed active worktree. The SDK
 *             never creates a second workspace, versions slot, or service.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, emit, fail, frameworkToken, packageDir, readManifest, sdkMetaDir } from './util.mjs';
import { resolveConnection, frameworkFetch, transportExec, transportPut } from './connection.mjs';
import { packageGitIdentity, packageGitState } from '../../src/packages/git-state.mjs';

const TOKEN = frameworkToken();
const api = (conn, p, opts = {}) => frameworkFetch(conn, p, { token: TOKEN, ...opts });
const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

async function post(conn, p, body) {
  if (conn.framework_url) {
    try {
      const r = await fetch(`${conn.framework_url}${p}`, {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { ok: true, status: r.status, data: await r.json().catch(() => null) };
    } catch (e) {
      return { ok: false, error: `framework unreachable: ${String(e?.cause?.code ?? e?.message ?? e)}` };
    }
  }
  const bodyArg = body ? ` -H 'Content-Type: application/json' --data ${quote(JSON.stringify(body))}` : '';
  const auth = TOKEN ? ` -H ${quote(`Authorization: Bearer ${TOKEN}`)}` : '';
  const result = transportExec(conn, `curl -s -m 30 -X POST${auth}${bodyArg} ${quote(`http://127.0.0.1:8980${p}`)}`, {}, { capture: true });
  if (result.status !== 0) return { ok: false, error: result.stderr || 'framework unreachable through transport' };
  try { return { ok: true, status: 200, data: JSON.parse(result.stdout) }; }
  catch { return { ok: false, error: 'framework returned non-JSON' }; }
}

const RETIRED = {
  workspace: 'dev now targets the installed active worktree; there is no separate workspace.',
  slug: 'a Package has exactly one instance, so there is no slug to give it.',
  'use-live-data': 'release and dev share the same data; there is no isolated mode to opt out of.',
  'data-mode': 'release and dev share the same data; there is no isolated mode to choose.',
};

const SUBCOMMANDS = ['start', 'stop', 'status', 'reload', 'logs', 'sync'];
const USAGE = `Usage: termux-os-sdk dev <${SUBCOMMANDS.join('|')}> <package-id> [--source <repo>]`;

function sourceDir(id, flags) {
  const dir = packageDir(id, { source: flags.source ? path.resolve(String(flags.source)) : null });
  return path.resolve(dir);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function syncCopyAllowed(sourcePath, root) {
  const rel = path.relative(root, sourcePath);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  if (parts.some((part) => ['.git', '.sdk', 'tmp', 'backup', '.runtime', 'node_modules'].includes(part))) return false;
  const name = path.basename(sourcePath);
  return !name.includes('.before-') && !name.endsWith('.bak') && !name.endsWith('.backup');
}

function prepareCompactWorktree(source, sourceIdentity, tmp) {
  const base = path.basename(source);
  const compact = path.join(tmp, base);
  const cloned = run('git', [
    'clone', '--quiet', '--depth', '1', '--no-local', '--branch', sourceIdentity.branch, source, compact,
  ], { stdio: 'ignore' });
  if (cloned !== 0) throw new Error('could not create a shallow Git worktree for dev sync');

  // Keep the shallow commit/tree/index, but overlay the exact dirty host tree. This
  // preserves HEAD/branch/status without shipping the host repository's full history.
  for (const entry of fs.readdirSync(compact)) {
    if (entry !== '.git') fs.rmSync(path.join(compact, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source)) {
    const from = path.join(source, entry);
    if (!syncCopyAllowed(from, source)) continue;
    fs.cpSync(from, path.join(compact, entry), { recursive: true, dereference: false, force: true });
  }
  if (sourceIdentity.origin) {
    run('git', ['-C', compact, 'remote', 'set-url', 'origin', sourceIdentity.origin], { stdio: 'ignore' });
  }
  return compact;
}

async function makeSyncArchive(source, id) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-os-dev-sync-'));
  const archive = path.join(tmp, `${id}.tar.gz`);
  const sourceIdentity = packageGitIdentity(source);
  const compact = prepareCompactWorktree(source, sourceIdentity, tmp);
  const parent = path.dirname(compact);
  const base = path.basename(compact);
  const status = run('tar', [
    '-czf', archive,
    '--exclude=.sdk', '--exclude=tmp', '--exclude=backup', '--exclude=.runtime',
    '--exclude=node_modules', '--exclude=*.before-*', '--exclude=*.bak', '--exclude=*.backup',
    '-C', parent, base,
  ], { stdio: 'ignore' });
  if (status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('could not create the dev sync archive');
  }
  const sha = await sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, `${sha}  ${path.basename(archive)}\n`);
  return { tmp, archive, sha };
}

function remoteFrameworkRoot(conn) {
  if (conn.transport.framework_root) return conn.transport.framework_root;
  if (conn.transport.type === 'local') {
    const installed = path.join(os.homedir(), '.termux-os', 'framework');
    return fs.existsSync(installed) ? installed : path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '../..'));
  }
  return '$HOME/.termux-os/framework';
}

async function cmdDevSync(flags, id, conn) {
  const source = sourceDir(id, flags);
  if (!fs.existsSync(path.join(source, 'termux-os.package.json'))) {
    return fail(flags, 'source_not_found', source, 'Run this command from the Package repository or pass --source <repository>.');
  }
  let manifest;
  try { manifest = readManifest(source); } catch (error) {
    return fail(flags, 'manifest_unreadable', String(error.message), 'Fix termux-os.package.json and retry.');
  }
  if (manifest.id !== id) return fail(flags, 'package_id_mismatch', `${manifest.id} != ${id}`, 'Pass the source repository for the requested Package ID.');
  const sourceIdentity = packageGitIdentity(source);
  const sourceState = packageGitState(source);
  if (!sourceIdentity.head || !sourceIdentity.branch) {
    return fail(flags, 'source_not_git', source, 'Dev sync requires a Git worktree with a named branch and HEAD.');
  }

  const before = await api(conn, `/api/dev/packages/${id}/status`);
  if (!before.ok) return fail(flags, 'framework_unreachable', before.error, 'Start Framework and retry.');
  if (!before.data?.ok) return fail(flags, before.data?.error ?? 'reconcile_failed', before.data?.fix ?? null, before.data?.reconcile ?? null);
  const reconcile = before.data.reconcile;
  if (reconcile?.conflict) return fail(flags, 'package_reconcile_required', reconcile.conflicts, 'Archive the reported legacy workspace or resolve the duplicate, then retry.');
  if (reconcile?.active?.version !== manifest.version) {
    return fail(flags, 'version_mismatch', `active=${reconcile?.active?.version} source=${manifest.version}`, 'Dev sync does not change Package version identity; release/install the version change first.');
  }

  const archive = await makeSyncArchive(source, id);
  const remoteBase = `${id}-dev-sync-${Date.now()}.tar.gz`;
  const remotePath = conn.transport.type === 'local'
    ? archive.archive
    : `$HOME/.termux-os/tmp/${remoteBase}`;
  try {
    if (conn.transport.type !== 'local') {
      const prep = transportExec(conn, 'mkdir -p "$HOME/.termux-os/tmp"', flags, { capture: true });
      if (prep.status !== 0) return fail(flags, 'sync_prepare_failed', prep.stderr, 'Create the private Framework temporary directory and retry.');
      if (transportPut(conn, archive.archive, `~/.termux-os/tmp/${remoteBase}`, flags) !== 0
        || transportPut(conn, `${archive.archive}.sha256`, `~/.termux-os/tmp/${remoteBase}.sha256`, flags) !== 0) {
        return fail(flags, 'sync_transfer_failed', null, 'Verify the connection transport and retry.');
      }
    }
    const root = remoteFrameworkRoot(conn);
    const commandPath = conn.transport.type === 'local' ? quote(archive.archive) : `"${remotePath}"`;
    const targetEnv = conn.transport.type === 'local' && conn.framework_url
      ? { FRAMEWORK_BASE_URL: conn.framework_url, ...(TOKEN ? { TERMUX_OS_TOKEN: TOKEN } : {}) }
      : {};
    const result = transportExec(conn,
      `cd ${quote(root)} && node scripts/package-manager.mjs dev-sync ${commandPath}`,
      flags, { capture: true, env: targetEnv });
    if (result.status !== 0) {
      return fail(flags, 'dev_sync_failed', result.stderr || result.stdout, 'The active tree was restored if the swap or reload failed. Inspect reconcile and retry.');
    }
    const after = await api(conn, `/api/dev/packages/${id}/status`);
    if (!after.ok || !after.data?.ok) return fail(flags, 'sync_postcheck_unreachable', after.error ?? after.data, 'Query Framework status and retry only after it is healthy.');
    const output = {
      ok: true, operation: 'dev-sync', package_id: id, source,
      target: { active_path: reconcile.active.path, version: reconcile.active.version },
      before: { state: reconcile.state, head: reconcile.git.head, changes: reconcile.git.changes },
      source_git: sourceIdentity, source_state: sourceState.state,
      after: after.data,
      diff: { head_changed: reconcile.git.head !== sourceIdentity.head, source_changes: sourceState.changes },
    };
    emit(output, flags, (o) => {
      console.log('✓ Synced host Git worktree into the one active Package worktree and reloaded it.');
      console.log(`  Source: ${o.source}`);
      console.log(`  Target: ${o.target.active_path}`);
      console.log(`  State : ${o.after.state}  generation=${o.after.runtime_generation ?? 'none'}`);
      console.log(`  Owner : ${(o.after.services ?? []).join(', ') || 'no declared services'}`);
    });
  } finally {
    if (conn.transport.type !== 'local') {
      transportExec(conn, `rm -f -- "${remotePath}" "${remotePath}.sha256"`, flags, { capture: true });
    }
    fs.rmSync(archive.tmp, { recursive: true, force: true });
  }
}

export async function cmdDev(flags, pos) {
  const [sub, id] = pos;
  for (const [gone, why] of Object.entries(RETIRED)) {
    if (flags[gone] !== undefined) return fail(flags, 'retired_option', `--${gone}`, why);
  }
  if (!SUBCOMMANDS.includes(sub ?? '')) return fail(flags, 'unknown_dev_subcommand', sub ?? '(missing)', USAGE);
  if (!id) return fail(flags, 'missing_package_id', null, USAGE);
  const conn = resolveConnection(flags);

  if (sub === 'sync') return cmdDevSync(flags, id, conn);

  const show = (o) => {
    console.log(`Package  : ${o.package_id}`);
    console.log(`State    : ${o.state_summary ?? o.state ?? 'unknown'}   ← read from the active worktree`);
    console.log(`Watching : ${o.watching ? `yes (${o.watch_mode})` : 'no'}`);
    console.log(`Generation: ${o.runtime_generation ?? 'none'}${o.runtime_owner ? ` (owner pid ${o.runtime_owner.pid})` : ''}`);
    if (o.services?.length) console.log(`Services : ${o.services.join(', ')}`);
    if (o.last_reload) console.log(`Reloaded : ${o.last_reload}`);
    if (o.reconcile?.legacy_workspaces?.length) console.log(`Legacy   : ${o.reconcile.legacy_workspaces.length} (reconcile required)`);
  };

  if (sub === 'status') {
    const r = await api(conn, `/api/dev/packages/${id}/status`);
    if (!r.ok) return fail(flags, 'framework_unreachable', r.error, 'Start Framework and retry.');
    if (!r.data?.ok) return fail(flags, r.data?.error ?? 'status_failed', r.data?.detail ?? null, r.data?.fix ?? null);
    return emit(r.data, flags, show);
  }

  if (sub === 'logs') {
    const manifest = (() => { try { return readManifest(sourceDir(id, flags)); } catch { return null; } })();
    const services = manifest?.components?.services ?? [];
    if (!services.length) return fail(flags, 'no_services', id, 'This Package declares no Stage Service to read logs from.');
    const lines = [];
    for (const sid of services) {
      const r = await api(conn, `/api/stage/services/${sid}/logs?lines=${flags.lines ?? 200}`);
      if (r.ok && r.data?.ok) lines.push(...(r.data.lines ?? []).map((line) => `[${sid}] ${line}`));
    }
    return emit({ ok: true, package_id: id, lines }, flags, (o) => o.lines.forEach((line) => console.log(line)));
  }

  const endpoint = sub === 'start' ? '/api/dev/packages'
    : sub === 'stop' ? `/api/dev/packages/${id}/stop` : `/api/dev/packages/${id}/reload`;
  const response = await post(conn, endpoint, sub === 'start' ? { package_id: id } : null);
  if (!response.ok) return fail(flags, 'framework_unreachable', response.error, 'Start Framework and retry.');
  if (!response.data?.ok) return fail(flags, response.data?.error ?? `dev_${sub}_failed`, response.data?.detail ?? null, response.data?.fix ?? null);
  const status = await api(conn, `/api/dev/packages/${id}/status`);
  const merged = { ok: true, action: sub, ...(status.ok && status.data?.ok ? status.data : { package_id: id }) };
  return emit(merged, flags, (o) => {
    console.log(sub === 'start' ? '✓ Watching the active Package worktree; edits reload in place.'
      : sub === 'stop' ? '✓ Stopped watching. The active worktree keeps its Git state and runtime owner.' : '✓ Reloaded.');
    show(o);
    if (sub === 'stop' && o.state === 'dev') {
      console.log('Note: restore the saved Release archive only when you intentionally want to discard edits.');
    }
  });
}

export { sdkMetaDir };
