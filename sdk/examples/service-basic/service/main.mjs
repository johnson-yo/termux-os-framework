/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/service-basic/service/main.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import http from 'node:http';
import { writeStatus } from './status.mjs';
import { loadConfig } from './config.mjs';
import { systemKeyAuthorized } from './http-auth.mjs';

const STATUS_FILE = process.env.STATUS_FILE || '.runtime-dev/status.json';
const CONFIG_FILE = process.env.CONFIG_FILE || '.runtime-dev/conf.json';
const PORT = Number(process.env.PORT);
const BIND_HOST = process.env.TERMUX_OS_PORT_HTTP_HOST || '127.0.0.1';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';

const state = { state: 'starting', started_at: new Date().toISOString(),
  counter: 0, last_activity_ms: 0, last_error: null };
const flush = () => writeStatus(STATUS_FILE, state);

let cfg;
try { cfg = loadConfig(CONFIG_FILE); } catch (e) {
  state.state = 'error'; state.last_error = 'config unreadable: ' + e.message; flush();
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT <= 0 || !SYSTEM_KEY) {
  state.state = 'error';
  state.last_error = 'Framework did not inject PORT and TERMUX_OS_SYSTEM_KEY';
  flush();
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, service: 'example-counter', state: state.state });
  }
  if (!systemKeyAuthorized(req.headers.authorization, SYSTEM_KEY)) {
    return send(401, { ok: false, error: 'unauthorized' });
  }
  if (req.method === 'GET' && req.url === '/status') {
    return send(200, { ok: true, service: 'example-counter', status: state });
  }
  return send(404, { ok: false, error: 'not_found' });
});

server.listen(PORT, BIND_HOST, () => {
  console.log('[example-counter] started host=' + BIND_HOST + ' port=' + PORT + ' interval=' + cfg.interval_ms + 'ms status=' + STATUS_FILE);
});
flush();

// Replace this timer with the real queue, feed, or stateful work.
const timer = setInterval(() => {
  try {
    state.counter += 1;
    state.last_activity_ms = Date.now();
    state.state = 'idle';
    state.last_error = null;
  } catch (e) {
    state.state = 'degraded';
    state.last_error = String(e.message ?? e);
  }
  flush();
}, cfg.interval_ms);

const bye = () => {
  clearInterval(timer);
  state.state = 'stopped';
  flush();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
