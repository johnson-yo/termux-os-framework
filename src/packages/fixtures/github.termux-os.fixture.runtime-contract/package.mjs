/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/packages/fixtures/github.termux-os.fixture.runtime-contract/package.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export async function register(context) {
  context.actions.register({
    id: 'fixture.runtime.echo', name: 'Fixture Runtime Echo', adapter: 'fixture',
    available: async () => true, run: async (value) => value,
  });
}
