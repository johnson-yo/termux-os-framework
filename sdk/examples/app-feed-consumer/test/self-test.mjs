/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/app-feed-consumer/test/self-test.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeState, readState } from '../app/state.mjs';

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-feed-consumer-'));
const cf = path.join(tmp, 'cursor.json');
writeState(cf, { after: 42, seen: ['a'] });
t('cursor state survives a restart', readState(cf).after === 42);
t('missing state returns null', readState(path.join(tmp, 'no.json')) === null);
// Add matching, ordering, and duplicate-suppression tests.
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
