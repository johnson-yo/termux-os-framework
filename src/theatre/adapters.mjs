/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/theatre/adapters.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

// ============================================================
// builtin adapter —— framework 自身能力，永遠可用
// ============================================================
export const builtinActions = [
  {
    id: 'debug.echo',
    name: 'Echo',
    adapter: 'builtin',
    available: async () => true,
    run: async (value) => value,
  },
];
