/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/adapter-http/test/self-test.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, saveConfig } from '../adapter/config.mjs';
import { probe } from '../adapter/probe.mjs';
import { makeActions } from '../adapter/actions.mjs';

let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-http-'));
const cf = path.join(tmp, 'conf.json');

t('missing config starts with an empty endpoint', loadConfig(cf).endpoint === '');
t('probe truthfully fails before configuration', (await probe(loadConfig(cf))).ok === false);

const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
saveConfig(cf, { endpoint: 'http://127.0.0.1:' + srv.address().port });

t('fixture provider is reachable', (await probe(loadConfig(cf))).ok === true);
const actions = makeActions(() => loadConfig(cf));
t('registered echo Action is available and callable', (await actions[1].available()) === true
  && (await actions[1].run('hi')).echo === 'hi');

srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
