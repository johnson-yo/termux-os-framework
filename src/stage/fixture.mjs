/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/stage/fixture.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 8991);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  if (new URL(req.url, 'http://x').pathname === '/health') {
    return res.end(JSON.stringify({ ok: true, service: 'stage.hello', pid: process.pid }));
  }
  res.end(JSON.stringify({ service: 'stage.hello' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`stage.hello started pid=${process.pid}`));

process.on('SIGTERM', () => {
  console.log('stage.hello stopping');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
});
