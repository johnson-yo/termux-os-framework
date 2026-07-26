/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/app-feed-consumer/package.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

export async function register(context) {
  const manifest = JSON.parse(fs.readFileSync(path.join(context.root, 'termux-os.package.json'), 'utf8'));
  const STATUS = path.join(context.frameworkRoot, '.runtime/services/app.example-feed-consumer/status.json');

  context.services.register({
    id: 'app.example-feed-consumer',
    name: 'Example Feed Consumer Worker',
    command: context.nodeExecutable,
    args: ['app/worker.mjs'],
    cwd: context.root,
    env: {
      STATUS_FILE: STATUS,
      CURSOR_FILE: path.join(context.frameworkRoot, '.runtime/services/app.example-feed-consumer/cursor.json'),
    },
    stop_timeout_ms: 5000,
  });

  context.apps.register({
    id: 'example-feed-consumer',
    name: manifest.name,
    url: '/packages/' + context.packageId + '/',
    requires: manifest.capabilities.requires,
  });

  context.routes.register('GET', '/status', async (req, res, { json }) => {
    let worker = null;
    try { worker = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { /* Not started yet. */ }
    json(res, 200, { ok: true, worker,
      hint: worker ? null : 'Start this worker from Administration / Services or the Stage service API.' });
  });
}
