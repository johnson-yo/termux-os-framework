/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/adapter-http/adapter/actions.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { call } from './client.mjs';
import { probe } from './probe.mjs';

export const makeActions = (cfg) => [
  {
    id: 'example-http.probe',
    name: 'Example HTTP Adapter Probe',
    adapter: 'example-http',
    available: async () => true,
    run: async () => probe(cfg()),
  },
  {
    id: 'example-http.echo',
    name: 'Example HTTP Adapter Echo',
    adapter: 'example-http',
    available: async () => (await probe(cfg())).ok,
    run: async (value) => {
      // Replace this fixture with the external provider's documented API call.
      return { echo: value };
    },
  },
];
