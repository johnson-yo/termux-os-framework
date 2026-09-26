/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Framework connection, an installed Package ID, and the Task04 protection choice.
 * [OUTPUT]: `restore`, `rollback`, `uninstall`, and `dev backup|backups|restore-backup` as SDK
 *           commands that run through the Framework's own Package lifecycle jobs.
 * [POS]: sdk/lib/lifecycle.mjs in termux-os-framework. The Agent-facing entry for operations the
 *        WebUI performs, so an Agent never calls scripts/package-manager.mjs or builds HTTP itself.
 * [PROTOCOL]: The SDK makes no safety decision. It forwards --preserve-development/--force-discard
 *             to the same job API the WebUI uses, and reports the installer's stable refusal code
 *             unchanged (development_backup_required, local_history_present, no_previous_release…).
 */

import { emit, fail, frameworkToken } from './util.mjs';
import { resolveConnection, frameworkFetch } from './connection.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function frameworkCall(conn, urlPath, opts = {}) {
  return frameworkFetch(conn, urlPath, { token: frameworkToken(), timeoutMs: 30000, ...opts });
}

/** JSON objects the installer printed: single-line objects and pretty-printed blocks, in order. */
export function jsonLines(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '{') {
      // A pretty-printed object runs to the first line that is exactly "}" at column 0.
      const end = lines.findIndex((line, j) => j > i && line === '}');
      if (end > i) {
        try { out.push(JSON.parse(lines.slice(i, end + 1).join('\n'))); i = end; continue; } catch { /* Not JSON. */ }
      }
    } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { out.push(JSON.parse(trimmed)); } catch { /* A log line that happens to start with a brace. */ }
    }
  }
  return out;
}

/** Poll a Package job to a terminal state. Framework restarts during install/restore are expected. */
async function awaitJob(conn, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await frameworkCall(conn, `/api/admin/package-manager/jobs/${jobId}`, { timeoutMs: 5000 });
    if (r.ok && r.data?.job) {
      last = r.data.job;
      if (!['queued', 'running'].includes(last.status)) return last;
    }
    await delay(1000);
  }
  return { ...(last ?? { id: jobId }), status: 'timeout' };
}

const PROTECTION_FIX = (id, verb) => `Re-run with --preserve-development to back up the whole work tree first `
  + `(termux-os-sdk ${verb} ${id} --preserve-development), or --force-discard to discard it.`;

const FIXES = {
  development_backup_required: PROTECTION_FIX,
  local_history_present: PROTECTION_FIX,
  official_baseline_unavailable: (id) => `${id} was created on this device and has no official Release yet; release and install it first.`,
  no_previous_release: (id) => `${id} has no previous Release on this device; nothing was changed.`,
  backup_not_found: (id) => `List backups with termux-os-sdk dev backups ${id}.`,
  package_job_active: () => 'Another Package job is running; wait for it and retry.',
  unknown_package: (id) => `${id} is not installed; list Packages with termux-os-sdk context.`,
  required_by_others: () => 'Uninstall the Packages that depend on it first.',
};

function protectionBody(flags) {
  if (flags['preserve-development'] && flags['force-discard']) return null;
  return {
    ...(flags['preserve-development'] ? { preserve_development: true } : {}),
    ...(flags['force-discard'] ? { force_discard: true } : {}),
  };
}

/**
 * Start one lifecycle job and wait for it. Returns the terminal job plus the installer's own
 * structured output; refusals keep the installer's stable code.
 */
async function runLifecycle(flags, id, action, extra = {}, verb = action) {
  const conn = resolveConnection(flags);
  const protection = protectionBody(flags);
  if (!protection) return fail(flags, 'protection_options_conflict', null, 'Choose either --preserve-development or --force-discard, not both.');
  const started = await frameworkCall(conn, `/api/admin/package-manager/packages/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', body: { confirm_package_id: id, ...protection, ...extra },
  });
  if (!started.ok) return fail(flags, 'framework_unreachable', started.error, 'Start Framework and retry.');
  if (!started.data?.ok) {
    const code = started.data?.error ?? `${verb}_failed`;
    return fail(flags, code, started.data?.detail ?? null, FIXES[code]?.(id, verb) ?? null);
  }
  const timeoutMs = Number(flags.timeout ?? 600) * 1000;
  const job = await awaitJob(conn, started.data.job.id, timeoutMs);
  const lines = jsonLines(job.output);
  const refusal = lines.find((o) => o?.ok === false && o.code);
  if (job.status !== 'success') {
    const code = refusal?.code ?? (job.status === 'timeout' ? 'job_timeout' : `${verb.replace(/-/g, '_')}_failed`);
    return fail(flags, code, refusal?.detail ?? job.error ?? null,
      FIXES[code]?.(id, verb) ?? `Inspect job ${job.id}: the previous state was kept or restored by the installer.`);
  }
  const result = [...lines].reverse().find((o) => o?.ok === true) ?? null;
  return { conn, job, result, output: job.output ?? '' };
}

/** Current installed truth after the job, so the caller does not need a second command. */
async function afterState(conn, id) {
  const status = await frameworkCall(conn, `/api/dev/packages/${id}/status`, { timeoutMs: 10000 });
  if (!status.ok || !status.data?.ok) return null;
  const d = status.data;
  return { state: d.state, provenance: d.provenance, version: d.reconcile?.active?.version ?? null,
    head: d.git?.head ?? null, branch: d.git?.branch ?? null, worktree: d.worktree };
}

async function waitFrameworkUp(conn, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await frameworkFetch(conn, '/health', { timeoutMs: 3000 });
    if (r.ok && r.data?.ok) return true;
    await delay(1000);
  }
  return false;
}

export async function cmdRestore(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk restore <package-id> [--preserve-development | --force-discard]');
  const r = await runLifecycle(flags, id, 'restore', {}, 'restore');
  await waitFrameworkUp(r.conn);
  const after = await afterState(r.conn, id);
  emit({ ok: true, action: 'restore', package_id: id, job_id: r.job.id, result: r.result, after,
    backup: /saved development backup/.test(r.output) ? r.output.match(/saved development backup[^\n]*/)[0] : null },
  flags, (o) => {
    console.log(`✓ Restored ${id} to its verified official Release.`);
    if (o.backup) console.log(`  ${o.backup}`);
    if (o.after) console.log(`  State: ${o.after.state}  ${o.after.version ?? ''} @ ${String(o.after.head ?? '').slice(0, 12)}`);
  });
}

export async function cmdRollback(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk rollback <package-id>');
  const conn = resolveConnection(flags);
  const snapshot = await frameworkCall(conn, '/api/admin/package-manager');
  if (!snapshot.ok) return fail(flags, 'framework_unreachable', snapshot.error, 'Start Framework and retry.');
  const item = (snapshot.data?.packages ?? []).find((p) => p.id === id);
  if (!item) return fail(flags, 'not_installed', id, FIXES.unknown_package(id));
  if (!item.previous_version) return fail(flags, 'no_previous_release', `${id} has no previous Release on this device`, FIXES.no_previous_release(id));
  const r = await runLifecycle(flags, id, 'rollback', { confirm_previous_version: item.previous_version }, 'rollback');
  await waitFrameworkUp(r.conn);
  const after = await afterState(r.conn, id);
  emit({ ok: true, action: 'rollback', package_id: id, job_id: r.job.id, from_version: item.version,
    to_version: item.previous_version, after }, flags, (o) => {
    console.log(`✓ Rolled ${id} back ${o.from_version} → ${o.to_version}.`);
    if (o.after) console.log(`  State: ${o.after.state}  active=${o.after.version}`);
  });
}

export async function cmdUninstall(flags, pos) {
  const id = pos[0];
  if (!id) return fail(flags, 'missing_package_id', null, 'Usage: termux-os-sdk uninstall <package-id> [--preserve-development | --force-discard]');
  const r = await runLifecycle(flags, id, 'uninstall', {}, 'uninstall');
  await waitFrameworkUp(r.conn);
  emit({ ok: true, action: 'uninstall', package_id: id, job_id: r.job.id, result: r.result,
    backup: /saved development backup/.test(r.output) ? r.output.match(/saved development backup[^\n]*/)[0] : null },
  flags, (o) => {
    console.log(`✓ Uninstalled ${id}. Its config/ directory, if any, was kept.`);
    if (o.backup) console.log(`  ${o.backup}`);
  });
}

/** dev backup | backups | restore-backup */
export async function cmdDevBackup(flags, sub, id, selector) {
  const conn = resolveConnection(flags);
  if (sub === 'backups') {
    const r = await frameworkCall(conn, `/api/dev/packages/${id}/development/backups`);
    if (!r.ok) return fail(flags, 'framework_unreachable', r.error, 'Start Framework and retry.');
    if (!r.data?.ok) return fail(flags, r.data?.error ?? 'backups_failed', r.data?.detail ?? null, null);
    return emit({ ok: true, package_id: id, backups: r.data.backups ?? [] }, flags, (o) => {
      if (!o.backups.length) { console.log(`No development backups for ${id}.`); return; }
      for (const b of o.backups) {
        console.log(`${b.name}\n  ${b.created_at ?? ''}  ${b.branch ?? 'detached'} @ ${String(b.head ?? '').slice(0, 12)}  stash=${b.stash_count ?? 0}  ${b.reason ?? ''}`);
      }
    });
  }
  if (sub === 'backup') {
    const r = await runLifecycle(flags, id, 'backup', {}, 'dev backup');
    // Report the backup as the list shows it (branch, HEAD, refs, stash), not just its file name.
    const made = r.result?.backup ?? null;
    const listed = await frameworkCall(conn, `/api/dev/packages/${id}/development/backups`);
    const backup = (listed.ok && listed.data?.ok ? listed.data.backups ?? [] : []).find((b) => b.name === made?.name) ?? made;
    return emit({ ok: true, action: 'dev-backup', package_id: id, job_id: r.job.id, backup }, flags, (o) => {
      console.log(`✓ Backed up ${id}'s whole work tree (.git, branches, stash).`);
      if (o.backup) console.log(`  ${o.backup.name ?? o.backup.path}`);
    });
  }
  // restore-backup
  if (!selector) return fail(flags, 'missing_backup', null, `Usage: termux-os-sdk dev restore-backup ${id} <backup-name|sha256-prefix> [--preserve-development | --force-discard]`);
  const r = await runLifecycle(flags, id, 'restore-backup', { backup: selector }, 'dev restore-backup');
  await waitFrameworkUp(r.conn);
  const after = await afterState(r.conn, id);
  return emit({ ok: true, action: 'dev-restore-backup', package_id: id, job_id: r.job.id, backup: selector,
    result: r.result, after }, flags, (o) => {
    console.log(`✓ Restored ${id} from development backup ${o.backup}.`);
    if (o.after) console.log(`  State: ${o.after.state}  ${o.after.branch ?? 'detached'} @ ${String(o.after.head ?? '').slice(0, 12)}`);
  });
}
