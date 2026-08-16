/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Package ID and the Installed Root.
 * [OUTPUT]: A cross-process exclusive lock for one Package identity.
 * [POS]: src/packages/operation-lock.mjs in termux-os-framework.
 * [PROTOCOL]: Package writes are serialized by ID. The lock is metadata only;
 *             it never represents Package state and is safe to discard when
 *             its owner process is gone.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedRoot } from './installed-root.mjs';

const held = new Set();
const lockRoot = (root = installedRoot()) => process.env.PACKAGE_OPERATION_LOCK_DIR
  || path.join(root, '.locks');
const lockName = (id) => encodeURIComponent(String(id)).replaceAll('%', '_');

function ownerPath(dir) { return path.join(dir, 'owner.json'); }

function readOwner(dir) {
  try { return JSON.parse(fs.readFileSync(ownerPath(dir), 'utf8')); } catch { return null; }
}

function ownerAlive(owner) {
  if (!owner || owner.pid !== process.pid) {
    try { process.kill(Number(owner?.pid), 0); return true; } catch (error) {
      return error?.code === 'EPERM';
    }
  }
  return true;
}

function makeLock(id, dir) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.delete(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* A crashed owner may have won the cleanup race. */ }
  };
  held.add(dir);
  return { id, path: dir, release };
}

function tryAcquire(id, root) {
  const dir = path.join(lockRoot(root), lockName(id));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = readOwner(dir);
    // mkdir() claims the directory before the owner marker is written. Treat a
    // very young marker-less directory as busy instead of letting a second
    // process steal the claim during that tiny publication window.
    let markerPending = false;
    if (!owner) {
      try { markerPending = Date.now() - fs.statSync(dir).mtimeMs < 5_000; } catch { /* Reconcile below. */ }
    }
    if (markerPending || ownerAlive(owner)) {
      const busy = Object.assign(new Error(`Package operation already holds ${id}`), {
        code: 'package_operation_locked', owner, lock_path: dir,
      });
      throw busy;
    }
    // Rename first so another waiter cannot mistake our stale cleanup for its lock.
    const stale = `${dir}.stale-${process.pid}-${Date.now()}`;
    try { fs.renameSync(dir, stale); } catch { return null; }
    try { fs.rmSync(stale, { recursive: true, force: true }); } catch { /* Best effort; it is no longer active. */ }
    return null;
  }
  fs.writeFileSync(ownerPath(dir), `${JSON.stringify({
    schema: 'termux-os.package-operation-lock.v1',
    package_id: id,
    pid: process.pid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
  }, null, 2)}\n`);
  return makeLock(id, dir);
}

export function acquirePackageLockSync(id, { root = installedRoot(), timeoutMs = 60_000, pollMs = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const lock = tryAcquire(id, root);
      if (lock) return lock;
    } catch (error) {
      if (error?.code === 'package_operation_locked') {
        if (Date.now() - started >= timeoutMs) throw error;
      } else throw error;
    }
    // This is used by the CLI only. A short bounded sleep avoids a second
    // Package operation observing a half-written active tree.
    const until = Date.now() + pollMs;
    while (Date.now() < until) { /* synchronous wait without a shell process */ }
  }
  const error = Object.assign(new Error(`timed out waiting for Package operation lock: ${id}`), {
    code: 'package_operation_lock_timeout', package_id: id,
  });
  throw error;
}

export async function acquirePackageLock(id, { root = installedRoot(), timeoutMs = 60_000, pollMs = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const lock = tryAcquire(id, root);
      if (lock) return lock;
    } catch (error) {
      if (error?.code !== 'package_operation_locked') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw Object.assign(new Error(`timed out waiting for Package operation lock: ${id}`), {
    code: 'package_operation_lock_timeout', package_id: id,
  });
}

process.once('exit', () => {
  for (const dir of [...held]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Process exit cleanup is best effort. */ }
  }
});

if (process.argv[1] && process.argv[1].endsWith('operation-lock.mjs') && process.argv.includes('--self-test')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-lock-'));
  const first = acquirePackageLockSync('github.termux-os.fixture.lock', { root: tmp, timeoutMs: 1000 });
  let busy = false;
  try { acquirePackageLockSync(first.id, { root: tmp, timeoutMs: 150 }); }
  catch (error) { busy = ['package_operation_locked', 'package_operation_lock_timeout'].includes(error.code); }
  console.log(`${busy ? 'ok' : 'FAIL'} concurrent same-id operation is rejected`);
  first.release();
  const second = acquirePackageLockSync(first.id, { root: tmp, timeoutMs: 1000 });
  console.log(`${second ? 'ok' : 'FAIL'} lock is reusable after release`);
  second.release();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(busy ? 0 : 1);
}
