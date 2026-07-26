/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/packages/workspace-hash.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WORKSPACE_HASH_SKIP = new Set(['.git', '.sdk', 'node_modules', '.DS_Store', '.runtime']);

export function hashWorkspace(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (WORKSPACE_HASH_SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) { h.update(`${r}\0`); h.update(fs.readFileSync(path.join(d, e.name))); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}
