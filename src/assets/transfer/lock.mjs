/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: One or more content-addressed Payload ids and a synchronous mutation.
 * [OUTPUT]: A short-lived cross-process lock for commit/delete byte transitions.
 * [POS]: src/assets/transfer/lock.mjs in termux-os-framework.
 * [PROTOCOL]: Locking prevents concurrent byte phases; it never decides Asset policy or ownership.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { payloadIdFor, sharedStore } from '../registry.mjs';

const digestId = (value) => /^[0-9a-f]{64}$/i.test(String(value ?? ''));
const lockRoot = () => path.join(sharedStore(), '.locks');
const lockPath = (payloadId) => {
  if (!digestId(payloadId)) throw Object.assign(new Error('payload lock id is invalid'), { code: 'payload_id_invalid' });
  return path.join(lockRoot(), `${String(payloadId).toLowerCase()}.lock`);
};

const ownerAlive = (owner) => {
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

const acquire = (payloadId) => {
  const target = lockPath(payloadId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, token: crypto.randomBytes(12).toString('hex'), created_at: new Date().toISOString() };
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(path.join(target, 'owner.json'), 'utf8')); } catch { /* stale/corrupt lock */ }
    if (ownerAlive(previous)) throw Object.assign(new Error(`payload ${payloadId} is busy`), { code: 'payload_operation_busy' });
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(target, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  return { target, owner };
};

const release = (lock) => {
  try {
    const current = JSON.parse(fs.readFileSync(path.join(lock.target, 'owner.json'), 'utf8'));
    if (current?.pid === lock.owner.pid && current?.token === lock.owner.token) {
      fs.rmSync(lock.target, { recursive: true, force: true });
    }
  } catch { /* crash/replacement already removed the lock */ }
};

/** Acquire all ids in lexical order so two multi-payload commits cannot deadlock. */
export function withPayloadLocks(payloadIds, mutation) {
  if (typeof mutation !== 'function') throw new Error('payload lock mutation must be a function');
  const ids = [...new Set((payloadIds ?? []).map((id) => String(id).toLowerCase()))].sort();
  const locks = [];
  try {
    for (const id of ids) locks.push(acquire(id));
    return mutation();
  } finally {
    for (const lock of locks.reverse()) release(lock);
  }
}

export const __test = { lockPath, ownerAlive };

// ============================================================
// Self-test: node src/assets/transfer/lock.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join('/tmp', 'asset-lock-'));
  process.env.SHARED_ASSET_STORE = root;
  const payloadId = payloadIdFor([{ path: 'x', size: 1, sha256: 'a'.repeat(64) }]);
  const first = withPayloadLocks([payloadId], () => {
    let busy = false;
    try { withPayloadLocks([payloadId], () => {}); } catch (error) { busy = error.code === 'payload_operation_busy'; }
    return busy;
  });
  test('same-process re-entry is rejected while mutation is active', first === true);
  test('lock is released after mutation', withPayloadLocks([payloadId], () => true) === true);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
