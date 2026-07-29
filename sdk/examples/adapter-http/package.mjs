/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/adapter-http/package.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './adapter/config.mjs';
import { makeActions } from './adapter/actions.mjs';

export async function register(context) {
  // Package 的設定歸 Package 自己保管，不放進 Framework 的持久樹。
  const CONF = context.configFile('example-http.v1.json');
  const cfg = () => loadConfig(CONF);
  for (const a of makeActions(cfg)) context.actions.register(a);

  // Publish a Capability only after the external provider is usable:
  // context.capabilities.provide({ id: '<capability>', provider: 'example-http', kind: 'action', action: 'example-http.echo' });

  context.routes.register('GET', '/config', async (req, res, { json }) => {
    const c = cfg();
    json(res, 200, { ok: true, config: { ...c, credential: c.credential ? '***' : '' }, path: CONF });
  });
  context.routes.register('POST', '/config', async (req, res, { json, readBody }) => {
    const body = await readBody();
    if (!body) return json(res, 400, { ok: false, error: 'invalid json' });
    const applied = saveConfig(CONF, body);
    if (!applied.length) return json(res, 400, { ok: false, error: 'no editable field (endpoint/credential)' });
    json(res, 200, { ok: true, applied });
  });
  // Exercise the registered Action path and report each observed layer separately.
  context.routes.register('POST', '/test', async (req, res, { json }) => {
    const { probe } = await import('./adapter/probe.mjs');
    const reachable = await probe(cfg());
    let invoked = null;
    if (reachable.ok) {
      try { invoked = { ok: true, value: await makeActions(cfg()).find((a) => a.id === 'example-http.echo').run('ping') }; }
      catch (e) { invoked = { ok: false, error: String(e.message ?? e) }; }
    }
    json(res, 200, { ok: true, reachable, registered: true, invoked,
      hint: reachable.ok ? null : 'Configure the endpoint on this Package page and verify that the provider is running.' });
  });
}
