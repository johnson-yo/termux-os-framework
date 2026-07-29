/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Framework configuration file path, given as the first argument.
 * [OUTPUT]: The fingerprint of the settings a user chose, on stdout.
 * [POS]: scripts/conf-fingerprint.mjs in termux-os-framework. Used by the update boundary check.
 *
 *        The boundary check used to hash the configuration file's bytes, which made "this version
 *        added a key" indistinguishable from "someone edited the user's settings" and therefore
 *        forbade any migration during an update. Comparing the settings instead lets a new version
 *        introduce its own keys while still failing the update if a value the user chose changed.
 * [PROTOCOL]: Print `unreadable` rather than failing, so a damaged file is a visible difference.
 */

import fs from 'node:fs';
import { configFingerprint } from '../src/system/config-migrate.mjs';

const file = process.argv[2];
try {
  process.stdout.write(configFingerprint(JSON.parse(fs.readFileSync(file, 'utf8'))));
} catch {
  process.stdout.write('unreadable');
}
