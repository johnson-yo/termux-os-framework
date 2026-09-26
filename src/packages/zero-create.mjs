/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A generated Package tree (staging directory), the Installed Root, and `git`.
 * [OUTPUT]: `createDevelopmentPackage`: a development-only Installed Package whose active version
 *           directory is the one Git work tree, with a local baseline commit and provenance.
 * [POS]: src/packages/zero-create.mjs in termux-os-framework. The on-phone zero-create path:
 *        no source repository elsewhere, no Release archive, no install, no Framework restart.
 * [PROTOCOL]: A development-only Package has no official baseline: `archive_sha256`, `hashes`,
 *             `base_release_sha256` and `base_released_head` stay null/empty and are never faked.
 *             The initial commit is the local Git baseline, not a release. Git identity is written
 *             only to the repository's own `.git/config`, never to a tracked file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { installedRoot, ACTIVE_FILENAME, ACTIVE_SCHEMA } from './installed-root.mjs';
import { writeDevelopment } from './provenance.mjs';
import { PLACEHOLDER_IDENTITY } from './git-state.mjs';

export { PLACEHOLDER_IDENTITY };
export const SOURCE_KIND_DEVELOPMENT = 'development';

const git = (dir, args, env = {}) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', ...env },
}).trim();

/** Global identity if the user has one; otherwise a clearly marked local placeholder. */
export function resolveGitIdentity() {
  const read = (key) => { try { return execFileSync('git', ['config', '--global', key], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const name = read('user.name');
  const email = read('user.email');
  return name && email ? { name, email, kind: 'global' } : { ...PLACEHOLDER_IDENTITY, kind: 'placeholder' };
}

/** A development-only active.json: honest about having no official Release. */
export const isDevelopmentOnly = (active) => active?.source_kind === SOURCE_KIND_DEVELOPMENT && !active?.archive_sha256;

/**
 * Turn a generated tree into a development-only Installed Package.
 * `staging` is moved (not copied) into `<root>/<id>/versions/<version>`; on any failure the
 * partially created Package root is removed and the error is returned with a stable code.
 */
export function createDevelopmentPackage({ id, staging, root = installedRoot(), branch = 'main' }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'termux-os.package.json'), 'utf8'));
  if (manifest.id !== id) return { ok: false, code: 'package_id_mismatch', detail: `${manifest.id} != ${id}` };
  const packageRoot = path.join(root, id);
  if (fs.existsSync(path.join(packageRoot, ACTIVE_FILENAME)) || fs.existsSync(path.join(packageRoot, 'versions'))) {
    return { ok: false, code: 'package_already_installed', detail: packageRoot };
  }
  const version = manifest.version;
  const worktree = path.join(packageRoot, 'versions', version);
  const identity = resolveGitIdentity();
  // A config/ kept by an earlier uninstall belongs to the user; keep it, never remove it on failure.
  const keptConfig = fs.existsSync(path.join(packageRoot, 'config'));
  try {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    fs.renameSync(staging, worktree);
    git(worktree, ['init', '-q', '-b', branch]);
    git(worktree, ['config', 'user.name', identity.name]);
    git(worktree, ['config', 'user.email', identity.email]);
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-q', '-m', 'Initial development baseline']);
    const head = git(worktree, ['rev-parse', 'HEAD']);
    const now = new Date().toISOString();
    const active = {
      schema: ACTIVE_SCHEMA, id,
      active_version: version, active_target: 'generic',
      previous_version: null, previous_target: null,
      archive_sha256: null, installed_at: now, hashes: {},
      source_kind: SOURCE_KIND_DEVELOPMENT,
    };
    const tmp = path.join(packageRoot, `${ACTIVE_FILENAME}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, `${JSON.stringify(active, null, 2)}\n`);
    fs.renameSync(tmp, path.join(packageRoot, ACTIVE_FILENAME));
    const development = writeDevelopment(packageRoot, {
      package_id: id,
      base_version: version,
      base_target: 'generic',
      base_release_sha256: null,
      base_released_head: null,
      development_only: true,
      local_baseline_head: head,
      git_identity: identity.kind,
      activated_at: now,
      activated_from_branch: branch,
      activated_head: head,
    });
    return { ok: true, package_id: id, version, package_root: packageRoot, worktree, head, branch,
      identity: identity.kind, development, active };
  } catch (error) {
    if (keptConfig) {
      for (const name of fs.readdirSync(packageRoot)) if (name !== 'config') fs.rmSync(path.join(packageRoot, name), { recursive: true, force: true });
    } else fs.rmSync(packageRoot, { recursive: true, force: true });
    return { ok: false, code: 'zero_create_failed', detail: String(error?.stderr || error?.message || error).trim().slice(0, 400) };
  }
}
