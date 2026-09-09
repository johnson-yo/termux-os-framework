/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Payload id, explicit Selection detach set, and a Ledger generation expectation.
 * [OUTPUT]: A tombstone/CAS-protected payload deletion or a precise technical conflict.
 * [POS]: src/assets/transfer/removal.mjs in termux-os-framework.
 * [PROTOCOL]: This boundary never checks optionality, Package load state, or consumers; warning belongs to Manager.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  payloadObjectDir, payloadReferrers, readPayloadLedger, sharedStore, writePayloadLedger,
  syncCompatibilityRegistry,
} from '../registry.mjs';
import { safeRelativePath, sha256File } from './staging.mjs';
import { withPayloadLocks } from './lock.mjs';

const errorWithCode = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const under = (root, candidate) => {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target !== base && target.startsWith(`${base}${path.sep}`);
};

const operationKey = (selection) => `${selection.asset_id ?? ''}\u0000${selection.variant_id ?? 'generic'}`;

export function deleteImpact(payloadId, { ledger = readPayloadLedger(), declarations = [], consumers = [], runtime = null } = {}) {
  const payload = ledger.payloads?.[payloadId] ?? null;
  const selectedBy = payload ? payloadReferrers(ledger, payloadId) : [];
  return {
    schema: 'termux-os.asset-delete-impact.v2',
    payload_id: payloadId,
    ledger_generation: Number.isSafeInteger(ledger.generation) ? ledger.generation : null,
    exists: Boolean(payload),
    state: payload?.state ?? 'missing',
    layout: payload?.layout ?? null,
    storage_path: payload?.storage_path ?? null,
    package_id: payload?.package_id ?? null,
    version: payload?.version ?? null,
    provenance: payload?.provenance ?? null,
    files: payload?.files ?? [],
    bytes: (payload?.files ?? []).reduce((sum, file) => sum + (Number(file.size) || 0), 0),
    selected_by: selectedBy,
    package_provisioned: Boolean(payload?.package_id || payload?.provisioned_by),
    declarations: (declarations ?? []).filter((item) => selectedBy.some((selection) => selection.asset_id === item.asset_id && selection.variant_id === item.variant_id)),
    consumers: Array.isArray(consumers) ? consumers : [],
    runtime: runtime ?? { loaded: false },
    can_delete: Boolean(payload),
  };
}

const verifyLegacyFiles = (payload, { allowMissing = false } = {}) => {
  const root = path.resolve(String(payload.storage_path ?? ''));
  if (!under(sharedStore(), root)) throw errorWithCode('payload_outside_shared_store', 'legacy payload is outside the shared store');
  const expected = new Set();
  const missing = [];
  for (const file of payload.files ?? []) {
    if (!safeRelativePath(file.path)) throw errorWithCode('payload_file_path_invalid', `unsafe legacy path: ${file.path}`);
    const target = path.resolve(root, file.path);
    if (!under(root, target)) throw errorWithCode('payload_file_path_invalid', `legacy file escapes payload: ${file.path}`);
    expected.add(target);
    let stat;
    try { stat = fs.lstatSync(target); } catch {
      if (allowMissing) { missing.push(file.path); continue; }
      throw errorWithCode('payload_file_missing', file.path);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw errorWithCode('payload_file_not_regular', file.path);
    if (stat.size !== Number(file.size) || sha256File(target) !== file.sha256) throw errorWithCode('payload_checksum_mismatch', file.path);
  }
  const unknown = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, item.name);
      if (item.isDirectory()) walk(target);
      else if (item.isFile() && !expected.has(target)) unknown.push(path.relative(root, target));
      else if (!item.isDirectory()) unknown.push(path.relative(root, target));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { root, unknown, missing };
};

const removeExactLegacy = (payload) => {
  // A deleting tombstone is a recovery fact: a prior process may already have
  // removed one or more tracked files before it died.  Missing tracked files
  // are therefore okay while unknown entries remain a hard safety error.
  const verified = verifyLegacyFiles(payload, { allowMissing: payload.state === 'deleting' });
  if (verified.unknown.length) throw errorWithCode('legacy_untracked_entries', 'legacy payload contains untracked entries', { entries: verified.unknown });
  for (const file of payload.files ?? []) fs.rmSync(path.resolve(verified.root, file.path), { force: true });
  const dirs = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) walk(path.join(dir, item.name));
    dirs.push(dir);
  };
  if (fs.existsSync(verified.root)) walk(verified.root);
  for (const dir of dirs.sort((a, b) => b.length - a.length)) {
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* leave non-empty/vanished */ }
  }
  return { removed: true, path: verified.root };
};

const removePayloadBytes = (payload, payloadId) => {
  const target = path.resolve(String(payload.storage_path ?? ''));
  if (payload.layout === 'object') {
    const expected = path.resolve(payloadObjectDir(payloadId));
    if (target !== expected) throw errorWithCode('payload_object_path_mismatch', 'object path does not match payload id');
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    return { removed: true, path: target };
  }
  return removeExactLegacy(payload);
};

/**
 * Delete bytes after the caller has explicitly detached every current
 * Selection. The detach requirement protects references, not product policy.
 */
const deletePayloadLocked = (payloadId, { expectedGeneration = undefined, detach = [] } = {}) => {
  const ledger = readPayloadLedger();
  if (ledger.error) throw errorWithCode('payload_ledger_corrupt', ledger.error);
  const payload = ledger.payloads?.[payloadId];
  if (!payload) return { ok: false, error: 'payload_not_found', payload_id: payloadId };
  if (expectedGeneration !== undefined && Number(expectedGeneration) !== ledger.generation) {
    return { ok: false, error: 'generation_mismatch', expected_generation: Number(expectedGeneration), actual_generation: ledger.generation };
  }
  const refs = payloadReferrers(ledger, payloadId);
  const requested = new Set((detach ?? []).map((item) => typeof item === 'string' ? item : operationKey(item ?? {})));
  const referenceKeys = new Set(refs.map((ref) => ref.key));
  const missing = refs.filter((ref) => !requested.has(ref.key));
  const extra = [...requested].filter((key) => !referenceKeys.has(key));
  if ((missing.length || extra.length) && payload.state !== 'deleting') {
    return {
      ok: false,
      error: 'selection_detach_required',
      payload_id: payloadId,
      selected_by: refs,
      requested_detach: [...requested],
      extra_detach: extra,
    };
  }

  let marked = ledger;
  if (payload.state !== 'deleting') {
    marked = {
      ...ledger,
      payloads: { ...ledger.payloads, [payloadId]: { ...payload, state: 'deleting', deleting_at: new Date().toISOString() } },
      selections: { ...ledger.selections },
      tombstones: { ...ledger.tombstones, [payloadId]: { payload_id: payloadId, path: payload.storage_path, marked_at: new Date().toISOString() } },
    };
    for (const ref of refs) delete marked.selections[ref.key];
    try {
      marked = writePayloadLedger(marked, { expectedGeneration: ledger.generation });
      syncCompatibilityRegistry(marked);
    }
    catch (error) { if (error.code === 'generation_mismatch') return { ok: false, error: error.code, actual_generation: error.actual_generation }; throw error; }
  }
  try {
    // Use the tombstoned record for the byte phase.  This makes the same call
    // tolerant of a file disappearing after the intent write, and gives a
    // restarted reconcile the identical idempotent behavior.
    const removed = removePayloadBytes(marked.payloads?.[payloadId] ?? payload, payloadId);
    const current = readPayloadLedger();
    if (current.error) throw errorWithCode('payload_ledger_corrupt', current.error);
    const final = { ...current, payloads: { ...current.payloads }, tombstones: { ...current.tombstones } };
    delete final.payloads[payloadId];
    delete final.tombstones[payloadId];
    const done = writePayloadLedger(final, { expectedGeneration: current.generation });
    syncCompatibilityRegistry(done);
    return { ok: true, payload_id: payloadId, removed, detached: refs, ledger_generation: done.generation };
  } catch (error) {
    return { ok: false, error: error.code ?? 'payload_delete_failed', payload_id: payloadId, detail: String(error?.message ?? error), ledger_deleting: true, ledger_generation: marked.generation };
  }
};

/** Serialize the byte/tombstone phase with a concurrent commit for this object. */
export function deletePayload(payloadId, options = {}) {
  return withPayloadLocks([payloadId], () => deletePayloadLocked(payloadId, options));
}

/** Complete deletion tombstones left by a process crash. */
export function reconcilePayloadDeletions() {
  const ledger = readPayloadLedger();
  if (ledger.error) return { ok: false, error: 'payload_ledger_corrupt', detail: ledger.error };
  const results = [];
  for (const payloadId of Object.keys(ledger.tombstones ?? {})) {
    const result = deletePayload(payloadId, { expectedGeneration: readPayloadLedger().generation, detach: [] });
    results.push(result);
  }
  return { ok: true, results };
}

// ============================================================
// Self-test: node src/assets/transfer/removal.mjs --self-test
// ============================================================
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-removal-'));
  process.env.SHARED_ASSET_STORE = path.join(root, 'models');
  process.env.ASSETS_REGISTRY_DIR = path.join(root, 'registry');
  process.env.PACKAGES_INSTALLED_DIR = path.join(root, 'packages');
  const installed = path.join(process.env.PACKAGES_INSTALLED_DIR, 'pkg.asset', 'versions', '1.0.0');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(process.env.PACKAGES_INSTALLED_DIR, 'pkg.asset', 'active.json'), `${JSON.stringify({
    schema: 'termux-os.package-active.v1', id: 'pkg.asset', active_version: '1.0.0',
  })}\n`);
  fs.writeFileSync(path.join(installed, 'termux-os.package.json'), `${JSON.stringify({
    schema: 'termux-os.package.v1', id: 'pkg.asset', version: '1.0.0', assets: {
      provides: [{ id: 'model.raw', kind: 'model', payload: 'raw', files: { model: 'model.bin' } }],
    },
  })}\n`);
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('deletable');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const object = path.join(process.env.SHARED_ASSET_STORE, '.objects', 'sha256', sha256);
  // The payload id is the file-manifest digest, not the content digest.
  const { payloadIdFor, recordPayload } = await import('../registry.mjs');
  const files = [{ path: 'model.bin', size: bytes.length, sha256 }];
  const payloadId = payloadIdFor(files);
  const payloadRoot = path.join(process.env.SHARED_ASSET_STORE, '.objects', 'sha256', payloadId);
  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, 'model.bin'), bytes);
  recordPayload({ payloadId, files, storagePath: payloadRoot, selection: { asset_id: 'model.raw', variant_id: 'generic' }, package_id: 'pkg.asset' });
  const blocked = deletePayload(payloadId, { detach: [] });
  test('current Selection is reported, not silently ignored', blocked.error === 'selection_detach_required');
  const stale = deletePayload(payloadId, { expectedGeneration: 0, detach: ['model.raw\u0000generic'] });
  test('stale confirmation is rejected before detach-set evaluation', stale.error === 'generation_mismatch');
  const extra = deletePayload(payloadId, { detach: ['model.raw\u0000generic', 'stale\u0000generic'] });
  test('a stale extra detach reference is rejected instead of widening the delete set', extra.error === 'selection_detach_required'
    && extra.extra_detach?.includes('stale\u0000generic'));
  const done = deletePayload(payloadId, { expectedGeneration: blocked.actual_generation ?? 1, detach: ['model.raw\u0000generic'] });
  test('explicit detach allows package-provisioned bytes to be deleted', done.ok && !fs.existsSync(payloadRoot));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
