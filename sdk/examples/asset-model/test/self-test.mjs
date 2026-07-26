/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/asset-model/test/self-test.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(path.dirname(new URL(import.meta.url).pathname));
let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const m = JSON.parse(fs.readFileSync(path.join(HERE, 'termux-os.package.json'), 'utf8'));
t('asset Package declares no services or actions',
  m.types.includes('asset') && !m.components.services.length && !m.components.actions.length);
t('asset declarations match components.assets',
  m.assets.provides.every((a) => m.components.assets.includes(a.id)));
const aj = JSON.parse(fs.readFileSync(path.join(HERE, 'asset/asset.json'), 'utf8'));
t('asset metadata ID matches the manifest', aj.id === m.assets.provides[0].id);
process.exit(fails ? 1 : 0);
