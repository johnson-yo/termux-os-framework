/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Framework connection and the id of an installed Package.
 * [OUTPUT]: `cmdDev` — start/stop/status/reload/logs for the watcher over that Package.
 * [POS]: sdk/lib/dev.mjs in termux-os-framework. The CLI face of the file watcher.
 * [PROTOCOL]: `dev` never changes whether a Package counts as released or edited. It starts and
 *             stops automatic reload over the one installed work tree; the released/edited fact
 *             is read from Git. There is no "enter dev mode" action to offer, so do not add one.
 *             Keep this English header synchronized with behavior and public contracts.
 */

import { emit, fail, frameworkToken, packageDir, readManifest, sdkMetaDir } from './util.mjs';
import { resolveConnection, frameworkFetch } from './connection.mjs';

const TOKEN = frameworkToken();
const api = (conn, p, opts = {}) => frameworkFetch(conn, p, { token: TOKEN, ...opts });

async function post(conn, p, body) {
  if (!conn.framework_url) return { ok: false, error: 'dev requires a connection with framework_url.' };
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

/**
 * 舊模型的入口必須明確消失，而不是被靜默忽略。
 *
 * `--workspace`/`--slug`/`--use-live-data` 屬於「dev 是另一個 package」那套模型。
 * 悄悄忽略它們最糟：使用者會以為隔離資料區還在生效，而寫的其實是正式資料。
 */
const RETIRED = {
  workspace: 'dev now watches the installed Package; there is no separate workspace.',
  slug: 'a Package has exactly one instance, so there is no slug to give it.',
  'use-live-data': 'release and dev share the same data; there is no isolated mode to opt out of.',
  'data-mode': 'release and dev share the same data; there is no isolated mode to choose.',
};

const SUBCOMMANDS = ['start', 'stop', 'status', 'reload', 'logs'];
const USAGE = `Usage: termux-os-sdk dev <${SUBCOMMANDS.join('|')}> <package-id>`;

export async function cmdDev(flags, pos) {
  const [sub, id] = pos;
  for (const [gone, why] of Object.entries(RETIRED)) {
    if (flags[gone] !== undefined) return fail(flags, 'retired_option', `--${gone}`, why);
  }
  if (!SUBCOMMANDS.includes(sub ?? '')) return fail(flags, 'unknown_dev_subcommand', sub ?? '(missing)', USAGE);
  if (!id) return fail(flags, 'missing_package_id', null, USAGE);
  const conn = resolveConnection(flags);

  const show = (o) => {
    console.log(`Package  : ${o.package_id}`);
    console.log(`State    : ${o.state_summary ?? o.state ?? 'unknown'}   ← read from the work tree`);
    console.log(`Watching : ${o.watching ? `yes (${o.watch_mode})` : 'no'}`);
    if (o.services?.length) console.log(`Services : ${o.services.join(', ')}`);
    if (o.last_reload) console.log(`Reloaded : ${o.last_reload}`);
  };

  if (sub === 'status') {
    const r = await api(conn, `/api/dev/packages/${id}/status`);
    if (!r.ok) return fail(flags, 'framework_unreachable', r.error, 'Start Framework and retry.');
    if (!r.data?.ok) return fail(flags, r.data?.error ?? 'status_failed', r.data?.detail ?? null, r.data?.fix ?? null);
    return emit(r.data, flags, show);
  }

  if (sub === 'logs') {
    const manifest = (() => { try { return readManifest(packageDir(id)); } catch { return null; } })();
    const services = manifest?.components?.services ?? [];
    if (!services.length) return fail(flags, 'no_services', id, 'This Package declares no Stage Service to read logs from.');
    const lines = [];
    for (const sid of services) {
      const r = await api(conn, `/api/stage/services/${sid}/logs?lines=${flags.lines ?? 200}`);
      if (r.ok && r.data?.ok) lines.push(...(r.data.lines ?? []).map((l) => `[${sid}] ${l}`));
    }
    return emit({ ok: true, package_id: id, lines }, flags, (o) => o.lines.forEach((l) => console.log(l)));
  }

  const path = sub === 'start' ? '/api/dev/packages'
    : sub === 'stop' ? `/api/dev/packages/${id}/stop`
      : `/api/dev/packages/${id}/reload`;
  const body = sub === 'start' ? { package_id: id } : null;
  const r = await post(conn, path, body);
  if (!r.ok) return fail(flags, 'framework_unreachable', r.error, 'Start Framework and retry.');
  if (!r.data?.ok) return fail(flags, r.data?.error ?? `dev_${sub}_failed`, r.data?.detail ?? null, r.data?.fix ?? null);

  const status = await api(conn, `/api/dev/packages/${id}/status`);
  const merged = { ok: true, action: sub, ...(status.ok && status.data?.ok ? status.data : { package_id: id }) };
  return emit(merged, flags, (o) => {
    console.log(sub === 'start' ? '✓ Watching for changes; edits reload the installed Package in place.'
      : sub === 'stop' ? '✓ Stopped watching. The Package keeps whatever state its work tree has.'
        : '✓ Reloaded.');
    show(o);
    if (sub === 'stop' && o.state === 'dev') {
      console.log('Note: the work tree still differs from the release. Use');
      console.log(`      node scripts/package-manager.mjs restore ${o.package_id}   to return to it.`);
    }
  });
}

export { sdkMetaDir };
