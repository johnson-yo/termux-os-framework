/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/theatre/catalog.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export const scripts = [
  { id: 'framework-echo', name: 'Framework Echo', steps: ['debug.echo'] },
];

export const scenes = [
  { id: 'framework-echo', name: 'Framework Echo', cue: 'manual', script: 'framework-echo' },
];

export const acts = [
  { id: 'theatre-bootstrap', name: 'Theatre Bootstrap Demo', scenes: ['framework-echo'] },
];

export const getScript = (id) => scripts.find((s) => s.id === id);
export const getScene = (id) => scenes.find((s) => s.id === id);
