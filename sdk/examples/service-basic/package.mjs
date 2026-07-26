/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/service-basic/package.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './service/config.mjs';

const EDITABLE = { interval_ms: 'number' };

export async function register(context) {
  const STATUS_FILE = path.join(context.frameworkRoot, '.runtime/services/example-counter/status.json');
  const CONFIG_FILE = path.join(context.persistRoot, 'conf/example-counter.v1.json');

  context.services.register({
    id: 'example-counter',
    name: 'Example Counter',
    command: context.nodeExecutable,
    args: ['service/main.mjs'],
    cwd: context.root,
    // Core injects the assigned Package port, System Key, Framework URL, and Package ID.
    env: { STATUS_FILE, CONFIG_FILE },
    stop_timeout_ms: 5000,
  });

  context.routes.register('GET', '/status', async (req, res, { json }) => {
    let status = null;
    try { status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { /* Not started yet. */ }
    json(res, 200, { ok: true, service: 'example-counter', status,
      assigned_port: context.ports.get('http'),
      hint: status ? null : 'Start this service from Administration / Services or the Stage service API.' });
  });

  context.routes.register('GET', '/config', async (req, res, { json }) => {
    json(res, 200, { ok: true, config: loadConfig(CONFIG_FILE), editable: Object.keys(EDITABLE), restart_required: true });
  });

  context.routes.register('POST', '/config', async (req, res, { json, readBody }) => {
    const body = await readBody();
    if (!body) return json(res, 400, { ok: false, error: 'invalid json' });
    const cfg = loadConfig(CONFIG_FILE);
    const applied = [];
    for (const [k, t] of Object.entries(EDITABLE)) {
      if (body[k] !== undefined) {
        if (typeof body[k] !== t) return json(res, 400, { ok: false, error: k + ' must be ' + t });
        cfg[k] = body[k]; applied.push(k);
      }
    }
    if (!applied.length) return json(res, 400, { ok: false, error: 'no editable field', editable: Object.keys(EDITABLE) });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
    json(res, 200, { ok: true, applied, restart_required: true });
  });
}
