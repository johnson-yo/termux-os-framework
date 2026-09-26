/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An Installed Root entry (packageRoot, active.json, active version directory), its saved
 *          release metadata under `archive/`, and the Git work tree read through git-state.mjs.
 * [OUTPUT]: Development provenance (read/activate/clear), development backup listing, and
 *           `packageStateSnapshot`, the single
 *           state result shared by package-manager, the Dev API, and the install safety check.
 * [POS]: src/packages/provenance.mjs in termux-os-framework.
 * [PROTOCOL]: Three independent facts, never merged:
 *               provenance — official | development; sticky, persisted beside `versions/`, set only
 *                            by an explicit activation, cleared only by a verified official
 *                            restore/install that has passed its post-check;
 *               Git        — what the work tree actually holds, always read live, never stored;
 *               watcher    — runtime only (dev-runtime.mjs); it never reads or writes provenance.
 *             The metadata carries no credentials, e-mail, hostnames, addresses, or device identity.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCommitIdentity, gitHistoryScan, packageGitIdentity, packageGitState, GIT_STATE } from './git-state.mjs';

export const PROVENANCE = Object.freeze({ OFFICIAL: 'official', DEVELOPMENT: 'development' });
export const PACKAGE_STATE = Object.freeze({
  OFFICIAL: 'official', DEVELOPMENT: 'development', MODIFIED: 'modified', UNKNOWN: 'unknown', CONFLICTED: 'conflicted',
});
export const DEVELOPMENT_SCHEMA = 'termux-os.package-development.v1';
export const DEVELOPMENT_BACKUP_SCHEMA = 'termux-os.package-development-backup.v1';
const LEGACY_BACKUP_SCHEMA = 'termux-os.package-dirty-backup.v1';

/** Development backups live outside the Installed Root so uninstall and restore never touch them. */
export const developmentBackupRoot = (id) => path.join(os.homedir(), '.termux-os', 'package-archives', id);

export function listDevelopmentBackups(id) {
  let entries = [];
  try {
    entries = fs.readdirSync(developmentBackupRoot(id))
      .filter((name) => name.endsWith('.tar.gz.json'))
      .map((name) => { try { return JSON.parse(fs.readFileSync(path.join(developmentBackupRoot(id), name), 'utf8')); } catch { return null; } })
      .filter((item) => [DEVELOPMENT_BACKUP_SCHEMA, LEGACY_BACKUP_SCHEMA].includes(item?.schema) && item.package_id === id)
      .map((item) => ({ ...item, name: path.basename(item.archive ?? '') }));
  } catch { /* No backup directory is an empty, successful result. */ }
  return entries.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

const DEVELOPMENT_DIR = '.development';
const DEVELOPMENT_FILE = 'provenance.v1.json';

export const developmentPath = (packageRoot) => path.join(packageRoot, DEVELOPMENT_DIR, DEVELOPMENT_FILE);

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Saved metadata of the installed release (archive/<version>@<target>.json), or null. */
export function releaseMetadata(packageRoot, version, target = 'generic') {
  if (!packageRoot || !version) return null;
  return readJson(path.join(packageRoot, 'archive', `${version}@${target ?? 'generic'}.json`));
}

export function readDevelopment(packageRoot) {
  const data = packageRoot ? readJson(developmentPath(packageRoot)) : null;
  return data?.schema === DEVELOPMENT_SCHEMA ? data : null;
}

export function writeDevelopment(packageRoot, metadata) {
  const file = developmentPath(packageRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: DEVELOPMENT_SCHEMA, ...metadata }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return readDevelopment(packageRoot);
}

/** Only a verified official restore/install that passed its post-check may call this. */
export function clearDevelopment(packageRoot) {
  fs.rmSync(path.join(packageRoot, DEVELOPMENT_DIR), { recursive: true, force: true });
}

const REASON_TEXT = {
  development_provenance: 'development',
  worktree_modified: 'work tree modified',
  head_not_at_release: 'HEAD is not the released commit',
  local_refs: 'local branch/tag holds unreleased commits',
  stash: 'stash present',
};

/**
 * The one state answer. `history: false` skips the ref/stash scan for hot paths (a reload's
 * safety check); every protection decision must use the full scan.
 */
export function packageStateSnapshot({ versionRoot, packageRoot, active, conflicts = [], history = true } = {}) {
  const development = readDevelopment(packageRoot);
  const target = active?.active_target ?? 'generic';
  const release = releaseMetadata(packageRoot, active?.active_version, target);
  const releasedHead = release?.head ?? null;
  // A development-only Package has no official baseline; its history is measured against the
  // local baseline commit made at creation, which is never presented as a released commit.
  const localBaseline = !releasedHead ? development?.local_baseline_head ?? null : null;
  let git;
  if (history && localBaseline) {
    const scan = gitHistoryScan(versionRoot, localBaseline);
    git = { ...scan, released_head: null, local_baseline_head: localBaseline, official_baseline: false,
      head_relation: scan.available ? 'no-official-baseline' : scan.head_relation };
  } else if (history) git = { ...gitHistoryScan(versionRoot, releasedHead), official_baseline: Boolean(releasedHead) };
  else {
    const light = packageGitState(versionRoot);
    const identity = light.state === GIT_STATE.UNKNOWN ? {} : packageGitIdentity(versionRoot);
    git = {
      available: light.state !== GIT_STATE.UNKNOWN && Boolean(releasedHead), partial: true,
      reason: light.state === GIT_STATE.UNKNOWN ? light.reason : releasedHead ? null : 'released_head_unknown',
      worktree: light.state === GIT_STATE.UNKNOWN ? 'unknown' : light.state === GIT_STATE.DEV ? 'modified' : 'clean',
      changes: light.changes, ignored: light.ignored, head: identity.head ?? null, released_head: releasedHead,
      branch: identity.branch ?? null, detached: identity.detached === true,
      head_relation: !identity.head || !releasedHead ? 'unknown' : identity.head === releasedHead ? 'at-release' : 'not-at-release',
      local_refs: [], stash_count: 0,
      local_history: light.state === GIT_STATE.UNKNOWN ? null
        : light.state === GIT_STATE.DEV || Boolean(releasedHead && identity.head && identity.head !== releasedHead),
      official_baseline: Boolean(releasedHead),
    };
  }
  const reasons = [];
  if (development) reasons.push('development_provenance');
  if (git.worktree === 'modified') reasons.push('worktree_modified');
  if (git.head && git.released_head && git.head !== git.released_head) reasons.push('head_not_at_release');
  if (git.local_refs.length) reasons.push('local_refs');
  if (git.stash_count > 0) reasons.push('stash');

  let state; let reason;
  if (conflicts.length) { state = PACKAGE_STATE.CONFLICTED; reason = 'reconcile_required'; }
  else if (development) { state = PACKAGE_STATE.DEVELOPMENT; reason = 'development_provenance'; }
  else if (!git.available && git.worktree !== 'modified') { state = PACKAGE_STATE.UNKNOWN; reason = git.reason ?? 'lineage_unavailable'; }
  else if (git.local_history || git.worktree === 'modified') { state = PACKAGE_STATE.MODIFIED; reason = reasons[0] ?? 'worktree_modified'; }
  else { state = PACKAGE_STATE.OFFICIAL; reason = 'official_release'; }

  const detail = [];
  if (development?.development_only && !releasedHead) detail.push('no official baseline');
  if (git.worktree !== 'unknown') detail.push(git.worktree === 'modified' ? `${git.changes.length} change(s)` : 'clean');
  if (git.head_relation !== 'unknown' && git.head_relation !== 'no-official-baseline') detail.push(git.head_relation);
  if (localBaseline && git.commits_ahead) detail.push(`${git.commits_ahead} local commit(s)`);
  if (git.local_refs.length) detail.push(`${git.local_refs.length} local ref(s)`);
  if (git.stash_count) detail.push(`${git.stash_count} stash`);
  if (git.ignored?.length) detail.push(`⚠ ${git.ignored.length} ignored path(s)`);
  const summary = state === PACKAGE_STATE.CONFLICTED ? 'conflicted (reconcile required)'
    : state === PACKAGE_STATE.UNKNOWN ? `unknown (${reason})`
      : `${state}${detail.length ? ` (${detail.join(', ')})` : ''}`;

  return {
    schema: 'termux-os.package-state.v1',
    state, reason, summary,
    provenance: development ? PROVENANCE.DEVELOPMENT : PROVENANCE.OFFICIAL,
    development,
    development_only: Boolean(development?.development_only && !releasedHead),
    git,
    local_history_present: git.local_history === true,
    protection_required: Boolean(development) || git.local_history === true,
    protection_reasons: reasons,
    reasons_text: reasons.map((r) => REASON_TEXT[r] ?? r),
  };
}

/**
 * Explicit activation: record the official baseline and mark the Package as being developed.
 * It touches no Git file, creates no workspace or branch, and starts no watcher.
 */
export function activateDevelopment({ id, versionRoot, packageRoot, active, conflicts = [] }) {
  if (conflicts.length) return { ok: false, code: 'package_reconcile_required', detail: conflicts.map((c) => c.kind) };
  const existing = readDevelopment(packageRoot);
  if (existing) return { ok: false, code: 'development_already_active', development: existing };
  const target = active?.active_target ?? 'generic';
  const release = releaseMetadata(packageRoot, active?.active_version, target);
  const git = gitHistoryScan(versionRoot, release?.head ?? null);
  if (!git.available) {
    return {
      ok: false, code: 'development_lineage_unavailable', detail: git.reason,
      fix: 'This installed Package has no verifiable Git lineage (no .git or no released HEAD). '
        + 'Install a Release built with a Git baseline before developing it in place.',
    };
  }
  const development = writeDevelopment(packageRoot, {
    package_id: id,
    base_version: active.active_version,
    base_target: target,
    base_release_sha256: active.archive_sha256 ?? release?.sha256 ?? null,
    base_released_head: release.head,
    activated_at: new Date().toISOString(),
    activated_from_branch: git.branch,
    activated_head: git.head,
  });
  // Development means committing here; make that possible before the first edit.
  const identity = ensureCommitIdentity(versionRoot);
  return { ok: true, development, git_identity: identity.kind };
}
