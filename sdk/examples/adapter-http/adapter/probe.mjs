/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/adapter-http/adapter/probe.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { call } from './client.mjs';

export async function probe(cfg) {
  if (!cfg.endpoint) return { ok: false, reason: 'endpoint not configured' };
  try { await call(cfg, '/health', { timeout: 2000 }); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e.message ?? e) }; }
}
