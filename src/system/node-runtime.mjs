/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The current Node runtime environment, including an optional Termux prefix.
 * [OUTPUT]: The executable path safe for spawning another Node process.
 * [POS]: src/system/node-runtime.mjs in termux-os-framework.
 * [PROTOCOL]: Android Termux may report its dynamic linker as process.execPath; prefer the actual prefix/bin/node.
 */

import fs from 'node:fs';
import path from 'node:path';

export function nodeExecutable() {
  const configured = String(process.env.TERMUX_OS_NODE ?? '').trim();
  const prefixes = [process.env.PREFIX, process.env.TERMUX_PREFIX].filter(Boolean);
  const candidates = [configured, ...prefixes.map((prefix) => path.join(prefix, 'bin', 'node'))]
    .filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? process.execPath;
}

if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const value = nodeExecutable();
  console.log(`${fs.existsSync(value) ? 'PASS' : 'FAIL'} Node child-process executable resolves to an existing file`);
  process.exit(fs.existsSync(value) ? 0 : 1);
}
