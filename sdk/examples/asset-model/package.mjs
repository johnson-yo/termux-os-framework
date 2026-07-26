/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/asset-model/package.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export async function register(context) {
  context.routes.register('GET', '/status', async (req, res, { json }) => {
    json(res, 200, { ok: true, asset: context.assets.resolve('model.example-model') });
  });
}
