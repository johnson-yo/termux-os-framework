/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Dev Runtime mounts, the loaded Package records, and the Stage service list.
 * [OUTPUT]: workspaceSnapshot() — one entry per workspace instance, with every page it exposes.
 * [POS]: src/system/workspace-view.mjs in termux-os-framework. Backs /admin/system/workspace.
 *        The point is discoverability: a workspace exposes pages at instance-scoped URLs that
 *        nobody can guess, so the Framework lists them explicitly instead of leaving a newcomer
 *        to derive `/packages/<id>@<slug>/` from documentation.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { listDevMounts } from '../packages/dev-runtime.mjs';
import { listPackages, getPackage } from '../packages/loader.mjs';

/**
 * Every page a package record serves, as absolute URLs.
 *
 * A package declares pages through `manifest.menu` (paths already absolute) and through
 * `apps.register({ url })`. For a workspace instance both were registered under the
 * instance id, so the URLs are already instance-scoped — but a manifest menu is static
 * text written for the released id, so those need rewriting.
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
  // The default WebUI entry is always reachable even when the manifest declares no menu.
  const root = `/packages/${record.id}/`;
  if (!pages.has(root)) pages.set(root, { title: record.manifest.name ?? record.id, url: root });
  return [...pages.values()];
}

export function workspaceSnapshot({ services = [] } = {}) {
  const workspaces = listDevMounts().map((mount) => {
    const record = getPackage(mount.instance_id) ?? null;
    const released = getPackage(mount.package_id) ?? null;
    return {
      instance_id: mount.instance_id,
      package_id: mount.package_id,
      slug: mount.workspace_slug,
      workspace: mount.workspace,
      started_at: mount.started_at,
      watch_mode: mount.watch_mode,
      seq: mount.seq,
      source_hash: mount.source_hash,
      status: record?.status ?? 'failed',
      error: record?.error ?? mount.last_error ?? null,
      version: record?.manifest?.version ?? null,
      types: record?.manifest?.types ?? [],
      pages: pagesOf(record),
      services: (record?.registered?.services ?? []).map((id) => ({
        id, state: services.find((s) => s.id === id)?.process?.state ?? 'unknown',
      })),
      // Shown side by side so it is obvious the released copy kept running.
      released: released
        ? { version: released.manifest?.version ?? null, status: released.status,
            url: `/packages/${released.id}/` }
        : null,
    };
  });

  // Installed packages with no workspace yet — the natural next action is to mount one.
  const mountedIds = new Set(workspaces.map((w) => w.package_id));
  const mountable = listPackages()
    .filter((p) => !p.id.includes('@') && !mountedIds.has(p.id))
    .map((p) => ({ package_id: p.id, name: p.name ?? p.id, version: p.version ?? null }));

  return { ok: true, workspaces, mountable };
}
