/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Framework connection and a Stage Service ID (or a Package ID filter for `list`).
 * [OUTPUT]: `service list|status|start|stop|restart|logs` with a post-check after every change.
 * [POS]: sdk/lib/service.mjs in termux-os-framework. A thin client of /api/stage/services; the
 *        Stage supervisor stays the only owner of process state.
 * [PROTOCOL]: The Package filter is a view over the one Stage service list, never a second state.
 *             Stable codes: service_not_found, service_postcheck_failed, plus Stage's own refusals.
 */

import { emit, fail } from './util.mjs';
import { resolveConnection } from './connection.mjs';
import { frameworkCall } from './lifecycle.mjs';

const SUBCOMMANDS = ['list', 'status', 'start', 'stop', 'restart', 'logs'];
const USAGE = 'Usage: termux-os-sdk service <list [<package-id>]|status|start|stop|restart|logs <service-id>> [--json]';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Agent-facing projection of one Stage service status. */
export function serviceView(s) {
  return {
    id: s.id, name: s.name ?? null, package_id: s.package ?? null, app: s.app ?? null,
    desired: s.desired ?? null, state: s.process?.state ?? 'unknown', pid: s.process?.pid ?? null,
    started_at: s.process?.started_at ?? null, exit_code: s.process?.exit_code ?? null,
    health: s.health?.state ?? s.health?.status ?? null,
  };
}

export async function listStageServices(conn) {
  const r = await frameworkCall(conn, '/api/stage/services');
  if (!r.ok || !r.data?.ok) return { ok: false, error: r.error ?? r.data?.error ?? 'stage_unavailable' };
  return { ok: true, services: r.data.services ?? [] };
}

async function oneService(conn, id) {
  const list = await listStageServices(conn);
  if (!list.ok) return list;
  const found = list.services.find((s) => s.id === id);
  return found ? { ok: true, service: found } : { ok: false, error: 'service_not_found' };
}

const printService = (v) => console.log(
  `${v.id}  ${v.state}${v.pid ? ` pid=${v.pid}` : ''}  desired=${v.desired ?? 'n/a'}  health=${v.health ?? 'n/a'}${v.package_id ? `  [${v.package_id}]` : ''}`);

export async function cmdService(flags, pos) {
  const [sub, id] = pos;
  if (!SUBCOMMANDS.includes(sub ?? '')) return fail(flags, 'unknown_service_subcommand', sub ?? '(missing)', USAGE);
  const conn = resolveConnection(flags);

  if (sub === 'list') {
    const list = await listStageServices(conn);
    if (!list.ok) return fail(flags, 'framework_unreachable', list.error, 'Start Framework and retry.');
    const services = list.services.filter((s) => !id || s.package === id).map(serviceView);
    return emit({ ok: true, package_id: id ?? null, services }, flags, (o) => {
      if (!o.services.length) console.log(id ? `No Stage services declared by ${id}.` : 'No Stage services.');
      o.services.forEach(printService);
    });
  }

  if (!id) return fail(flags, 'missing_service_id', null, USAGE);
  const before = await oneService(conn, id);
  if (!before.ok) {
    return before.error === 'service_not_found'
      ? fail(flags, 'service_not_found', id, 'List services with termux-os-sdk service list [<package-id>].')
      : fail(flags, 'framework_unreachable', before.error, 'Start Framework and retry.');
  }

  if (sub === 'status') return emit({ ok: true, service: serviceView(before.service) }, flags, (o) => printService(o.service));

  if (sub === 'logs') {
    const lines = Number(flags.lines ?? 200);
    const r = await frameworkCall(conn, `/api/stage/services/${encodeURIComponent(id)}/logs?lines=${lines}`);
    if (!r.ok) return fail(flags, 'framework_unreachable', r.error, 'Start Framework and retry.');
    if (!r.data?.ok) return fail(flags, r.data?.error === 'unknown_service' ? 'service_not_found' : (r.data?.error ?? 'logs_failed'), id, null);
    return emit({ ok: true, service_id: id, lines: r.data.lines ?? [] }, flags, (o) => o.lines.forEach((line) => console.log(line)));
  }

  // start | stop | restart through the Stage control API, then a post-check on the same list.
  const r = await frameworkCall(conn, `/api/stage/services/${encodeURIComponent(id)}/${sub}`, { method: 'POST', timeoutMs: 60000 });
  if (!r.ok) return fail(flags, 'framework_unreachable', r.error, 'Start Framework and retry.');
  if (r.data?.ok === false) {
    const code = r.data.error === 'unknown_service' ? 'service_not_found' : (r.data.error_code ?? r.data.error ?? `service_${sub}_failed`);
    return fail(flags, code, r.data.detail ?? r.data.reason ?? null, r.data.fix ?? null);
  }
  const want = sub === 'stop' ? 'stopped' : 'running';
  const timeoutMs = Number(flags.timeout ?? 20) * 1000;
  const deadline = Date.now() + timeoutMs;
  let after = null;
  while (Date.now() < deadline) {
    const now = await oneService(conn, id);
    if (now.ok) {
      after = serviceView(now.service);
      const settled = want === 'stopped' ? after.state !== 'running' : after.state === 'running';
      const restarted = sub !== 'restart' || !before.service.process?.pid || after.pid !== before.service.process.pid;
      if (settled && restarted) break;
    }
    await delay(500);
  }
  const ok = Boolean(after) && (want === 'stopped' ? after.state !== 'running' : after.state === 'running')
    && (sub !== 'restart' || !before.service.process?.pid || after.pid !== before.service.process.pid);
  if (!ok) {
    return fail(flags, 'service_postcheck_failed', `${id} is ${after?.state ?? 'unknown'} after ${sub}; expected ${want}`,
      `Read termux-os-sdk service logs ${id}.`);
  }
  return emit({ ok: true, action: sub, service: after, before: serviceView(before.service) }, flags, (o) => {
    console.log(`✓ ${sub} ${id}`);
    printService(o.service);
  });
}
