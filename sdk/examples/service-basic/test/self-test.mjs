/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/service-basic/test/self-test.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStatus, readStatus } from '../service/status.mjs';
import { loadConfig } from '../service/config.mjs';
import { systemKeyAuthorized } from '../service/http-auth.mjs';

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-counter-'));
const sf = path.join(tmp, 'status.json');

writeStatus(sf, { state: 'idle', counter: 3 });
t('status is written atomically', readStatus(sf).counter === 3 && readStatus(sf).updated_at > 0);
t('missing status returns null', readStatus(path.join(tmp, 'nope.json')) === null);
t('atomic write leaves no temporary file', !fs.readdirSync(tmp).some((f) => f.endsWith('.tmp')));

const cf = path.join(tmp, 'conf.json');
const c1 = loadConfig(cf);
t('missing config is created from defaults', c1.interval_ms === 1000 && fs.existsSync(cf));
fs.writeFileSync(cf, JSON.stringify({ interval_ms: 250 }));
t('existing config is preserved', loadConfig(cf).interval_ms === 250);
t('System Key authentication accepts only the exact key',
  systemKeyAuthorized('Bearer test-key', 'test-key')
    && !systemKeyAuthorized('Bearer wrong', 'test-key')
    && !systemKeyAuthorized(undefined, 'test-key'));

// Add isolated tests for the Package's real behavior.

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
