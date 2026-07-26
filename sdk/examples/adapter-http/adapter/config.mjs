/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/adapter-http/adapter/config.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = { schema: 'termux-os-framework.example-http.conf.v1', endpoint: '', credential: '' };
const EDITABLE = ['endpoint', 'credential'];

export function loadConfig(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function saveConfig(file, body) {
  const cfg = loadConfig(file);
  const applied = [];
  for (const k of EDITABLE) {
    if (typeof body[k] === 'string') { cfg[k] = body[k]; applied.push(k); }
  }
  if (applied.length) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return applied;
}
