/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/adapter-http/adapter/client.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export async function call(cfg, path, init = {}) {
  if (!cfg.endpoint) throw new Error('endpoint not configured on this Package page');
  const r = await fetch(cfg.endpoint + path, {
    ...init,
    headers: { ...(cfg.credential ? { Authorization: 'Bearer ' + cfg.credential } : {}), 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(init.timeout ?? 5000),
  });
  if (!r.ok) throw new Error('vendor http ' + r.status);
  return r.json();
}
