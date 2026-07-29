/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A private state file path, the running version, and the address a request arrived on.
 * [OUTPUT]: Whether the control panel should open its setup step, and the record that it was completed.
 * [POS]: src/system/setup-state.mjs in termux-os-framework. Decides what a browser sees at /admin.
 *
 *        A freshly installed Framework generates a random administrator password into a private file
 *        and then shows a login form, so the only way in was to open Termux and run a command. The
 *        product assumes the opposite: the user's single interaction with Termux is launching it. The
 *        credentials therefore have to be presented once, in the browser, on the device itself.
 *
 *        "On the device itself" is the whole security boundary. Anyone reaching the panel over the
 *        network is a different person from the one holding the phone, so credentials are shown to
 *        loopback requests only; every other origin gets the login form regardless of setup state.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SETUP_STATE_SCHEMA = 'termux-os.setup-state.v1';

const EMPTY = { schema: SETUP_STATE_SCHEMA, claimed_at: null, acknowledged_version: null };

let config = { path: null, version: '0.0.0' };

export function configureSetupState({ path: statePath, version } = {}) {
  config = { path: statePath ?? null, version: version ?? '0.0.0' };
}

export function readSetupState(file = config.path) {
  if (!file) return { ...EMPTY };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schema !== SETUP_STATE_SCHEMA) return { ...EMPTY };
    return { ...EMPTY, ...value };
  } catch {
    return { ...EMPTY };
  }
}

export function writeSetupState(patch, file = config.path) {
  const next = { ...readSetupState(file), ...patch, schema: SETUP_STATE_SCHEMA };
  if (!file) return next;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/**
 * A request is local when it came from this device. IPv4-mapped IPv6 is the form Node reports on a
 * dual-stack listener, and it is still loopback; treating it as remote would lock the user out of
 * their own phone.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false;
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  return value === '127.0.0.1' || value === '::1' || value.startsWith('127.');
}

/**
 * What the panel should show. `setup` on a device that has never been claimed, `review` when this
 * version has not been acknowledged yet and the migration actually changed something, otherwise
 * `none`. A remote browser is never offered either, because both screens reveal credentials.
 */
export function setupDecision({ state, version = config.version, local, migrationChanged = false }) {
  if (!local) return 'none';
  if (!state.claimed_at) return 'setup';
  if (state.acknowledged_version !== version && migrationChanged) return 'review';
  return 'none';
}

if (process.argv.includes('--self-test')) {
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };

  test('a device nobody has set up yet opens setup',
    setupDecision({ state: { ...EMPTY }, version: '1.0.0', local: true }) === 'setup');
  test('a claimed device on the acknowledged version goes straight in',
    setupDecision({ state: { claimed_at: 'now', acknowledged_version: '1.0.0' }, version: '1.0.0', local: true }) === 'none');
  test('a new version that migrated something asks for review',
    setupDecision({ state: { claimed_at: 'now', acknowledged_version: '1.0.0' }, version: '1.1.0', local: true, migrationChanged: true }) === 'review');
  test('a new version that changed nothing does not interrupt',
    setupDecision({ state: { claimed_at: 'now', acknowledged_version: '1.0.0' }, version: '1.1.0', local: true }) === 'none');

  // The boundary: both screens show the administrator password, so neither is ever reachable
  // from another machine — not even on a device that has never been set up.
  test('a remote browser is never shown setup',
    setupDecision({ state: { ...EMPTY }, version: '1.0.0', local: false }) === 'none');
  test('a remote browser is never shown the review',
    setupDecision({ state: { claimed_at: 'now', acknowledged_version: '1.0.0' }, version: '1.1.0', local: false, migrationChanged: true }) === 'none');

  test('IPv4 loopback is local', isLoopbackAddress('127.0.0.1'));
  test('IPv6 loopback is local', isLoopbackAddress('::1'));
  // Node reports this form for IPv4 clients on a dual-stack listener.
  test('IPv4-mapped IPv6 loopback is local', isLoopbackAddress('::ffff:127.0.0.1'));
  test('a LAN address is not local', !isLoopbackAddress(['192', '168', '0', '5'].join('.')));
  test('a public address is not local', !isLoopbackAddress('203.0.113.7'));
  test('an absent address is not local', !isLoopbackAddress(undefined) && !isLoopbackAddress(''));

  // An unreadable or absent state file must read as "never set up" rather than throw, or a damaged
  // file would leave the panel unreachable in exactly the situation the user needs it most.
  test('a missing state file reads as unclaimed', readSetupState('/nonexistent/setup.json').claimed_at === null);

  console.log(fails === 0 ? 'PASS setup state' : `FAIL ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
