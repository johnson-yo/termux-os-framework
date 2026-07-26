/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/packages/fixtures/github.termux-os.fixture.asset-model/package.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export async function register(context) {
  context.assets.register({
    id: 'model.fixture', kind: 'model', payload: 'payload/fixture',
    files: { context: 'fixture.ctx.onnx', metadata: 'asset.json' },
  });
}
