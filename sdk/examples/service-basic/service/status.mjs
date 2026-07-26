/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/service-basic/service/status.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

export function writeStatus(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, updated_at: Date.now() }, null, 2));
  fs.renameSync(tmp, file);
}

export function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
