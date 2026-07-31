/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The workspace root on disk, Dev Runtime mounts, loaded Package records, Stage services.
 * [OUTPUT]: workspaceSnapshot / createWorkspace / packWorkspace / deleteWorkspace / workspaceRoot.
 * [POS]: src/system/workspace-view.mjs in termux-os-framework. Backs /admin/packages/workspace.
 *
 *        A workspace is a **directory on disk**; mounting is one of its properties, not its
 *        existence. Listing only mounted workspaces meant a project the user had created was
 *        invisible until they mounted it, so the only way to know what existed was to open a
 *        shell and run ls. Everything under the root is listed; a mount that lives outside the
 *        root is still listed, marked external, so adopting the standard root loses nothing.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listDevMounts } from '../packages/dev-runtime.mjs';
import { getPackage } from '../packages/loader.mjs';

const MANIFEST = 'termux-os.package.json';

/** Same resolution order as the SDK, so CLI and UI never disagree about where projects live. */
export function workspaceRoot(config = null) {
  return process.env.TERMUX_OS_DEV_ROOT
    || config?.workspace?.root
    || path.join(os.homedir(), 'termux-os-dev/packages');
}

const readManifest = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); }
  catch { return null; }
};

/** Slug identifies a workspace in the API. Directory name is the slug; both must stay URL-safe. */
export const toWorkspaceSlug = (value) => String(value ?? '')
  .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function directorySize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* raced */ } }
    }
  };
  walk(dir);
  return total;
}

/**
 * Every page a record serves, as absolute URLs. A workspace instance registers under
 * `<id>@<slug>`, so a menu path written for the released id needs rewriting.
 */
function pagesOf(record) {
  if (!record?.manifest) return [];
  const pages = new Map();
  const scope = (url) => (record.workspaceSlug && typeof url === 'string'
    ? url.replace(`/packages/${record.packageId}/`, `/packages/${record.id}/`)
    : url);
  for (const entry of record.manifest.menu ?? []) {
    if (!entry?.path) continue;
    pages.set(scope(entry.path), { title: entry.title ?? entry.path, url: scope(entry.path) });
  }
  const root = `/packages/${record.id}/`;
  if (!pages.has(root)) pages.set(root, { title: record.manifest.name ?? record.id, url: root });
  return [...pages.values()];
}

function describe(dir, { slug, external = false, mount = null, services = [] }) {
  const manifest = readManifest(dir);
  const record = mount ? getPackage(mount.instance_id) : null;
  const released = manifest?.id ? getPackage(manifest.id) : null;
  return {
    slug,
    path: dir,
    external,
    package_id: manifest?.id ?? null,
    name: manifest?.name ?? null,
    version: manifest?.version ?? null,
    types: manifest?.types ?? [],
    // A directory without a manifest is not a package project; say so rather than hiding it,
    // because the user put it there and needs to know why it cannot be mounted.
    valid: Boolean(manifest?.id),
    invalid_reason: manifest?.id ? null : `${MANIFEST} missing or unreadable`,
    size_bytes: directorySize(dir),
    mounted: Boolean(mount),
    mount: mount ? {
      instance_id: mount.instance_id,
      slug: mount.workspace_slug,
      status: record?.status ?? 'failed',
      error: record?.error ?? mount.last_error ?? null,
      watch_mode: mount.watch_mode,
      seq: mount.seq,
      pages: pagesOf(record),
      services: (record?.registered?.services ?? []).map((id) => ({
        id, state: services.find((s) => s.id === id)?.process?.state ?? 'unknown',
      })),
    } : null,
    released: released && !released.workspaceSlug
      ? { version: released.manifest?.version ?? null, status: released.status,
          url: `/packages/${released.id}/` }
      : null,
  };
}

export function workspaceSnapshot({ services = [], config = null } = {}) {
  const root = workspaceRoot(config);
  const mounts = listDevMounts();
  const byPath = new Map(mounts.map((m) => [path.resolve(m.workspace), m]));
  const projects = [];
  const seen = new Set();

  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* root may not exist yet */ }
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, entry.name);
    seen.add(path.resolve(dir));
    projects.push(describe(dir, {
      slug: toWorkspaceSlug(entry.name), mount: byPath.get(path.resolve(dir)) ?? null, services,
    }));
  }

  // A workspace mounted from outside the root still exists and must be manageable.
  for (const mount of mounts) {
    const dir = path.resolve(mount.workspace);
    if (seen.has(dir)) continue;
    projects.push(describe(dir, {
      slug: toWorkspaceSlug(path.basename(dir)), external: true, mount, services,
    }));
  }

  return { ok: true, root, root_exists: fs.existsSync(root), projects };
}

const resolveProject = (slug, config) => {
  const safe = toWorkspaceSlug(slug);
  if (!safe) return null;
  const root = workspaceRoot(config);
  // Directory name to slug is lossy: dots become dashes. Rebuilding the path by
  // concatenating the slug therefore points at something that does not exist for
  // every directory named after a Package id, which is all of them created outside
  // this UI. They list fine and then refuse to delete with unknown_workspace.
  // The mapping only works in one direction, so look the directory up instead.
  let name = safe;
  try {
    const match = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .find((entry) => toWorkspaceSlug(entry.name) === safe);
    if (match) name = match.name;
  } catch { /* Root may not exist yet; fall back to the slug itself. */ }
  const dir = path.join(root, name);
  // Refuse anything that escapes the root even after normalisation.
  if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep)) return null;
  return { safe, root, dir };
};

/**
 * Create a project from an SDK template, or from an installed package's archive.
 * The template is Framework-owned on purpose: it carries the conventions an agent
 * would otherwise have to re-derive for every new project.
 */
export function createWorkspace({ slug, packageId, type = 'service', name, fromDir = null, config = null }) {
  const target = resolveProject(slug, config);
  if (!target) return { ok: false, error: 'invalid_slug' };
  if (fs.existsSync(target.dir)) return { ok: false, error: 'already_exists', detail: target.dir };
  fs.mkdirSync(target.root, { recursive: true });

  if (fromDir) {
    if (!fs.existsSync(path.join(fromDir, MANIFEST))) {
      return { ok: false, error: 'source_has_no_manifest', detail: fromDir };
    }
    fs.cpSync(fromDir, target.dir, { recursive: true });
    return { ok: true, project: target.safe, path: target.dir, origin: 'installed' };
  }

  const sdk = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), '..', 'sdk', 'termux-os-sdk');
  const result = spawnSync(process.execPath, [sdk, 'new',
    '--type', type, '--id', packageId, '--name', name ?? packageId,
    '--workspace', target.root, '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) {
    return { ok: false, error: 'template_failed', detail: (result.stderr || result.stdout || '').trim().slice(0, 400) };
  }
  // The generator names the directory after the package id; adopt it as the slug.
  const generated = path.join(target.root, packageId);
  if (fs.existsSync(generated) && generated !== target.dir) fs.renameSync(generated, target.dir);
  return { ok: true, project: target.safe, path: target.dir, origin: 'template' };
}

/**
 * Deterministic archive of a project, for the browser to download.
 * Same flags as the release workflow: fixed order, mtime and ownership, so the same
 * input always produces the same bytes and a hash can identify it.
 */
export function packWorkspace({ slug, config = null }) {
  const target = resolveProject(slug, config);
  if (!target || !fs.existsSync(target.dir)) return { ok: false, error: 'unknown_workspace' };
  const manifest = readManifest(target.dir);
  if (!manifest?.id) return { ok: false, error: 'workspace_has_no_manifest' };

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-pack-'));
  const stem = `${manifest.id}-${manifest.version ?? '0.0.0'}`;
  const staged = path.join(out, stem);
  const allow = path.join(target.dir, 'public-files.txt');

  if (fs.existsSync(allow)) {
    for (const line of fs.readFileSync(allow, 'utf8').split('\n')) {
      const rel = line.trim();
      if (!rel || rel.startsWith('#')) continue;
      const from = path.join(target.dir, rel);
      if (!fs.existsSync(from)) return { ok: false, error: 'declared_file_missing', detail: rel };
      fs.mkdirSync(path.join(staged, path.dirname(rel)), { recursive: true });
      fs.copyFileSync(from, path.join(staged, rel));
    }
  } else {
    fs.cpSync(target.dir, staged, {
      recursive: true,
      filter: (src) => !['.git', 'node_modules', '.sdk', 'tmp'].includes(path.basename(src)),
    });
  }

  const archive = path.join(out, `${stem}.tar.gz`);
  const tar = spawnSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner',
    '--mtime=2020-01-01 00:00:00Z', '--format=gnu', '-czf', archive, '-C', out, stem],
    { encoding: 'utf8', timeout: 120_000 });
  if (tar.status !== 0) {
    fs.rmSync(out, { recursive: true, force: true });
    return { ok: false, error: 'pack_failed', detail: (tar.stderr || '').trim().slice(0, 300) };
  }
  return { ok: true, archive, filename: `${stem}.tar.gz`, cleanup: out };
}

export function deleteWorkspace({ slug, config = null }) {
  const target = resolveProject(slug, config);
  if (!target || !fs.existsSync(target.dir)) return { ok: false, error: 'unknown_workspace' };
  if (listDevMounts().some((m) => path.resolve(m.workspace) === path.resolve(target.dir))) {
    return { ok: false, error: 'mounted', fix: 'Stop the mount before deleting the project.' };
  }
  fs.rmSync(target.dir, { recursive: true, force: true });
  return { ok: true, project: target.safe };
}
