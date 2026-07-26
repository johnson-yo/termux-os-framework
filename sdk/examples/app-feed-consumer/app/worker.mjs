/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/app-feed-consumer/app/worker.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { readState, writeState } from './state.mjs';

const FW = process.env.TERMUX_OS_FRAMEWORK_URL || '';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';
const STATUS_FILE = process.env.STATUS_FILE || '.runtime-dev/status.json';
const CURSOR_FILE = process.env.CURSOR_FILE || '.runtime-dev/cursor.json';

const api = async (p, opts = {}) => {
  if (!FW || !SYSTEM_KEY) throw new Error('Framework URL or System Key was not injected');
  const r = await fetch(FW + p, {
    ...opts,
    headers: { Authorization: 'Bearer ' + SYSTEM_KEY, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error('Framework HTTP ' + r.status + ' for ' + p);
  return r.json();
};

const state = { state: 'starting', started_at: new Date().toISOString(),
  consumed: 0, last_item: null, last_error: null };
const flush = () => writeState(STATUS_FILE, state);
flush();

// Replace this with the Capability consumed by the real workflow.
const FEED_CAPABILITY = 'speech.transcript';

let running = true;
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

const cursor = readState(CURSOR_FILE) ?? { after: 0, seen: [] };

async function loop() {
  // Resolve the provider-neutral descriptor before reading a feed.
  const d = await api('/api/capabilities/' + FEED_CAPABILITY);
  if (!d?.endpoint) { state.state = 'degraded'; state.last_error = FEED_CAPABILITY + ' descriptor unavailable'; flush(); return; }
  state.state = 'idle'; flush();
  while (running) {
    try {
      // Adapt this example to the descriptor's documented feed shape.
      const r = await api(d.endpoint + '?after=' + cursor.after + '&limit=20');
      for (const item of r.utterances ?? []) {
        const id = item.utterance_id ?? JSON.stringify(item);
        if (cursor.seen.includes(id)) continue;
        // Perform the real workflow behavior here.
        state.consumed += 1;
        state.last_item = id;
        cursor.after = item.timing?.written_ms ?? cursor.after;
        cursor.seen = [...cursor.seen.slice(-63), id];
        writeState(CURSOR_FILE, cursor);
      }
      state.state = 'active'; state.last_error = null;
    } catch (e) { state.state = 'degraded'; state.last_error = String(e.message ?? e); }
    flush();
    await new Promise((r) => setTimeout(r, 1000));
  }
  state.state = 'stopped'; flush();
}
loop().then(() => process.exit(0));
