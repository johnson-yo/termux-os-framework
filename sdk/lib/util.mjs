/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/util.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultAuthFile, readAuthFile } from '../../src/system/auth-file.mjs';

export const SDK_ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
export const FW_ROOT = path.dirname(SDK_ROOT);
export const DEV_ROOT = process.env.TERMUX_OS_DEV_ROOT
  || path.join(os.homedir(), 'termux-os-dev/packages');
export const PKGS_DIR = DEV_ROOT;
export const defaultWorkspaceRoot = () => DEV_ROOT;

export function frameworkToken() {
  if (process.env.TERMUX_OS_TOKEN) return process.env.TERMUX_OS_TOKEN;
  try { return readAuthFile(process.env.FRAMEWORK_AUTH_FILE || defaultAuthFile()).admin_token; }
  catch { return null; }
}

/** Parse --flag value, boolean --flag, and positional arguments. */
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { flags[key] = argv[++i]; }
      else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

/** Emit one JSON object or a human-readable representation. */
export function emit(obj, flags, human) {
  if (flags.json) console.log(JSON.stringify(obj, null, 2));
  else human(obj);
}

/** Emit a stable error and exit non-zero. */
export function fail(flags, code, detail, fix) {
  const obj = { ok: false, code, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) };
  if (flags?.json) console.log(JSON.stringify(obj, null, 2));
  else {
    console.error(`✗ ${code}${detail ? `: ${detail}` : ''}`);
    if (fix) console.error(`  Next: ${fix}`);
  }
  process.exit(1);
}

/** Run a Core tool without hiding its output or exit status. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: FW_ROOT, ...opts });
  return r.status ?? 1;
}

/** Run a command and capture output for structured inspection. */
export function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: FW_ROOT, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'termux-os.package.json'), 'utf8'));
}

/** Resolve a Package from the current repository or the independent development root. */
export function packageDir(id) {
  try {
    if (readManifest(process.cwd()).id === id) return process.cwd();
  } catch { /* The current directory is not this package. */ }
  return path.join(DEV_ROOT, id);
}

export function listSourcePackages() {
  const out = [];
  const seen = new Set();
  const add = (dir, origin) => {
    try {
      const manifest = readManifest(dir);
      if (!seen.has(manifest.id)) {
        out.push({ id: manifest.id, dir, origin, manifest });
        seen.add(manifest.id);
      }
    } catch { /* Not a Package directory. */ }
  };
  add(process.cwd(), 'current-directory');
  let names = [];
  try { names = fs.readdirSync(DEV_ROOT); } catch { return out; }
  for (const name of names) {
    const dir = path.join(DEV_ROOT, name);
    try {
      if (fs.statSync(dir).isDirectory()) add(dir, 'workspace');
    } catch { /* The directory changed during the scan. */ }
  }
  return out;
}
