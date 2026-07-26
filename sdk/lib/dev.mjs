/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/dev.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { emit, fail, frameworkToken, packageDir, readManifest } from './util.mjs';
import { resolveConnection, frameworkFetch } from './connection.mjs';

const TOKEN = frameworkToken();
const api = (conn, p, opts = {}) => frameworkFetch(conn, p, { token: TOKEN, ...opts });

async function post(conn, p, body) {
  if (!conn.framework_url) return { ok: false, error: 'Dev Runtime requires a connection with framework_url.' };
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

const sessionFile = (ws) => path.join(ws, '.sdk/dev-session.v1.json');
const readSession = (ws) => { try { return JSON.parse(fs.readFileSync(sessionFile(ws), 'utf8')); } catch { return null; } };
const writeSession = (ws, s) => {
  fs.mkdirSync(path.dirname(sessionFile(ws)), { recursive: true });
  fs.writeFileSync(sessionFile(ws), JSON.stringify(s, null, 2));
};

/** Stage Service IDs declared by this Package. */
const pkgServices = (ws) => { try { return readManifest(ws).components?.services ?? []; } catch { return []; } };

async function logLines(conn, sid, lines = 500) {
  const r = await api(conn, `/api/stage/services/${sid}/logs?lines=${lines}`);
  return r.ok && r.data?.ok ? (r.data.lines ?? []) : null;
}

export async function cmdDev(flags, pos) {
  const [sub, id] = pos;
  const usage = 'Usage: termux-os-sdk dev <start|status|reload|logs|stop> <package-id>';
  if (!['start', 'status', 'reload', 'logs', 'stop'].includes(sub ?? '')) return fail(flags, 'unknown_dev_subcommand', sub ?? '(missing)', usage);
  if (!id) return fail(flags, 'missing_package_id', null, usage);
  const conn = resolveConnection(flags);

  // Local workspaces can be discovered; remote target paths must be explicit.
  let ws = flags.workspace ? path.resolve(String(flags.workspace)) : packageDir(id);
  const wsIsLocal = conn.transport.type === 'local';

  if (sub === 'start') {
    if (wsIsLocal && !fs.existsSync(path.join(ws, 'termux-os.package.json'))) {
      return fail(flags, 'workspace_not_found', ws, `Create the Package first or add --workspace <dir>.`);
    }
    if (!wsIsLocal && !flags.workspace) {
      return fail(flags, 'workspace_required', 'The connection is not local; the SDK will not guess a target path.',
        'Add --workspace <absolute-target-workspace>.');
    }
    const dataMode = flags['use-live-data'] ? 'live' : 'isolated';
    if (dataMode === 'live') {
      console.error('⚠ --use-live-data lets development code modify production configuration and data.');
    }
    const r = await post(conn, '/api/dev/packages', { package_id: id, workspace: ws, data_mode: dataMode });
    if (!r.ok) return fail(flags, 'framework_unreachable', r.error, 'Start Framework and retry.');
    if (!r.data?.ok) return fail(flags, r.data?.error ?? 'dev_start_failed', r.data?.detail ?? r.data?.error, r.data?.fix ?? 'Inspect Framework logs.');
    if (wsIsLocal) writeSession(ws, { schema: 'termux-os.dev-session.v1', package_id: id, started_at: r.data.mount.started_at, connection: conn.name ?? conn.source, log_marks: await currentMarks(conn, ws) });
    const url = conn.framework_url ? `${conn.framework_url}/packages/${id}/` : `/packages/${id}/`;
    emit({ ok: true, package: id, mode: 'DEV', workspace: ws, data_mode: dataMode,
      watch_mode: r.data.mount.watch_mode, shadow: r.data.mount.shadow, url }, flags, (o) => {
      console.log(`✓ Dev Mode started: ${o.package}`);
      if (o.shadow) console.log(`  Shadow: Installed ${o.shadow.version} remains untouched and returns after dev stop.`);
      console.log(`  Workspace: ${o.workspace}\n  Data mode: ${o.data_mode}\n  Watch: ${o.watch_mode}`);
      console.log(`\nOpen on this phone:\n\n${o.url}\n\nWeb changes refresh; backend changes reload automatically.`);
    });
    return;
  }

  if (sub === 'reload' || sub === 'stop') {
    const r = await post(conn, `/api/dev/packages/${id}/${sub === 'stop' ? 'stop' : 'reload'}`);
    if (!r.ok) return fail(flags, 'framework_unreachable', r.error, null);
    if (r.status === 404) return fail(flags, 'not_dev_mounted', id, `termux-os-sdk dev start ${id}`);
    if (!r.data?.ok && sub === 'reload') return fail(flags, 'dev_reload_failed', r.data?.error, 'Fix the Workspace code and retry.');
    emit({ ok: true, package: id, ...(sub === 'stop' ? { restored: r.data.restored, workspace_kept: r.data.workspace_kept } : { status: r.data.status }) },
      flags, (o) => {
        if (sub === 'stop') {
          console.log(`✓ Dev Mode stopped: ${o.package}`);
      console.log(o.restored ? `  Restored Installed ${o.restored.version} (${o.restored.status})` : '  No Installed version exists to restore.');
          console.log(`  Workspace kept: ${o.workspace_kept}`);
        } else console.log(`✓ Reloaded: ${o.package} (${o.status})`);
      });
    return;
  }

  if (sub === 'status') {
    const mounts = await api(conn, '/api/dev/packages');
    if (!mounts.ok) return fail(flags, 'framework_unreachable', mounts.error, 'Start Framework and retry.');
    const m = (mounts.data?.mounts ?? []).find((x) => x.package_id === id);
    if (!m) return fail(flags, 'not_dev_mounted', id, `termux-os-sdk dev start ${id}`);
    const ev = await api(conn, `/api/dev/packages/${id}/events`);
    const svcIds = wsIsLocal ? pkgServices(ws) : [];
    const stages = await api(conn, '/api/stage/services');
    const svc = (stages.data?.services ?? []).find((s) => svcIds.includes(s.id));
    const out = { ok: true, package: id, mode: 'DEV', workspace: m.workspace, source_hash: m.source_hash,
      framework_url: conn.framework_url, package_url: conn.framework_url ? `${conn.framework_url}/packages/${id}/` : null,
      watch: m.watch_mode, status: ev.data?.status ?? 'unknown', last_error: ev.data?.error ?? null,
      service: svc ? { id: svc.id, desired: svc.desired, process: svc.process?.state ?? 'unknown', health: svc.health?.state ?? 'unknown' } : null,
      data_mode: m.data_mode, shadow: m.shadow };
    emit(out, flags, (o) => {
      console.log(`Package:        ${o.package}\nMode:           DEV${o.status !== 'loaded' ? ` (load failed: ${o.last_error})` : ''}`);
      console.log(`Workspace:      ${o.workspace}\nSource hash:    ${o.source_hash.slice(0, 12)}…`);
      console.log(`Framework URL:  ${o.framework_url ?? 'n/a'}\nPackage URL:    ${o.package_url ?? 'n/a'}`);
      console.log(`Watch:          ${o.watch} (backend + web; dev reload is the manual fallback)`);
      console.log(`Service:        ${o.service ? `${o.service.id} desired=${o.service.desired} process=${o.service.process} health=${o.service.health}` : 'none'}`);
      console.log(`Data mode:      ${o.data_mode}`);
      console.log(`Installed:      ${o.shadow ? `${o.shadow.version} [shadowed; restored by dev stop]` : 'not installed'}`);
    });
    return;
  }

  // Logs begin at this Dev Session's view cursor; clear-view never deletes stored history.
  if (sub === 'logs') {
    if (!wsIsLocal) return fail(flags, 'logs_local_only', 'Dev log cursors currently require a local Workspace.', 'Use /api/stage/services/<service>/logs for a remote target.');
    const svcIds = pkgServices(ws);
    if (!svcIds.length) return fail(flags, 'no_services', `${id} declares no Stage Service`, 'There is no managed process log to read.');
    const sess = readSession(ws) ?? { log_marks: {} };
    if (flags['clear-view']) {
      sess.log_marks = await currentMarks(conn, ws);
      writeSession(ws, sess);
      console.log('✓ View cleared; stored log history was not deleted.');
      return;
    }
    const show = async () => {
      for (const sid of svcIds) {
        const lines = await logLines(conn, sid);
        if (lines === null) continue;
        const mark = sess.log_marks?.[sid] ?? 0;
        const fresh = lines.slice(mark);
        if (fresh.length) {
          for (const l of fresh) console.log(flags.json ? JSON.stringify({ service: sid, line: l }) : `[${sid}] ${l}`);
          sess.log_marks[sid] = lines.length;
        }
      }
    };
    await show();
    if (flags.follow) {
      console.error('--follow polls every 2 seconds; press Ctrl-C to stop.');
      // Bound follow to one hour so an abandoned client does not run indefinitely.
      for (let i = 0; i < 1800; i++) { await new Promise((r) => setTimeout(r, 2000)); await show(); }
    } else writeSession(ws, sess);
  }
}

async function currentMarks(conn, ws) {
  const marks = {};
  for (const sid of pkgServices(ws)) {
    const lines = await logLines(conn, sid);
    if (lines) marks[sid] = lines.length;
  }
  return marks;
}
