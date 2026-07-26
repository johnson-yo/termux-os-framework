/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/service-basic/service/config.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  schema: 'termux-os-framework.example-counter.conf.v1',
  enabled: true,
  interval_ms: 1000,
};

export function loadConfig(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}
