/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The Termux `$PREFIX` and the running Framework root.
 * [OUTPUT]: `ensureSdkShim`: `$PREFIX/bin/termux-os-sdk` as a symlink to `<framework>/sdk/termux-os-sdk`.
 * [POS]: src/system/sdk-shim.mjs in termux-os-framework. Called at every Framework start, so
 *        install, update and rollback all leave the command on PATH.
 * [PROTOCOL]: The link names the stable runtime path, never a versioned copy, so it follows
 *             whichever Framework is active and never holds a stale SDK. A file or foreign link
 *             already at that name is not Framework's: it is reported as a collision, never
 *             overwritten. No shell rc file is touched.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SDK_COMMAND = 'termux-os-sdk';

/** A link Framework made earlier: it points at some Framework's sdk/termux-os-sdk. */
const frameworkManaged = (target) => target.split(path.sep).slice(-2).join('/') === `sdk/${SDK_COMMAND}`;

/** Termux's prefix even when Framework was started without Termux's login environment. */
export function termuxPrefix(env = process.env) {
  if (env.PREFIX) return env.PREFIX;
  const home = env.HOME ?? '';
  return home.endsWith('/files/home') ? `${home.slice(0, -'/home'.length)}/usr` : null;
}

export function ensureSdkShim({ prefix = termuxPrefix(), frameworkRoot }) {
  if (process.env.TERMUX_OS_SDK_SHIM === '0') return { status: 'disabled' };
  if (!prefix) return { status: 'skipped', reason: 'no_prefix' };
  // Only Termux's private prefix is ours to write; a workstation /usr is never touched.
  if (process.env.TERMUX_OS_SDK_SHIM !== '1' && !process.env.TERMUX_VERSION && !prefix.includes('com.termux')) {
    return { status: 'skipped', reason: 'not_termux' };
  }
  const bin = path.join(prefix, 'bin');
  if (!fs.existsSync(bin)) return { status: 'skipped', reason: 'no_prefix_bin', bin };
  const link = path.join(bin, SDK_COMMAND);
  const target = path.join(frameworkRoot, 'sdk', SDK_COMMAND);
  if (!fs.existsSync(target)) return { status: 'skipped', reason: 'sdk_missing', target };
  try { fs.chmodSync(target, 0o755); } catch { /* A read-only tree keeps its mode. */ }

  let stat = null;
  try { stat = fs.lstatSync(link); } catch { /* Absent: install it. */ }
  if (stat && !stat.isSymbolicLink()) return { status: 'collision', link, reason: 'not_a_framework_link' };
  if (stat) {
    const current = fs.readlinkSync(link);
    if (current === target) return { status: 'current', link, target };
    if (!frameworkManaged(current)) return { status: 'collision', link, reason: 'foreign_link', current };
  }
  // Atomic replace: a concurrent shell sees either the old link or the new one, never neither.
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    return { status: 'failed', link, target, error: String(error?.message ?? error) };
  }
  return { status: stat ? 'updated' : 'installed', link, target };
}
