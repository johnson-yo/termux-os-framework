/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: A fixture action, HTTP route, and WebSocket route for loader tests.
 * [POS]: src/packages/fixtures/github.termux-os.fixture.valid/package.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export async function register(context) {
  context.actions.register({
    id: 'fixture.echo',
    name: 'Fixture Echo',
    adapter: 'fixture',
    available: async () => true,
    run: async (value) => value,
  });
  context.routes.register('GET', '/ping', async (req, res, { json }) => {
    json(res, 200, { ok: true, pong: true, package: context.packageId });
  });
  context.websockets.register('/stream', () => {});
  context.capabilities.provide({
    id: 'text.translate',
    provider: 'fixture.echo',
    kind: 'action',
    action: 'fixture.echo',
  });
}
