/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A verified staged file set, neutral provenance facts, and an optional Selection request.
 * [OUTPUT]: An immutable content-addressed Payload Object and a CAS-protected Ledger update.
 * [POS]: src/assets/transfer/commit.mjs in termux-os-framework.
 * [PROTOCOL]: Commit does not resolve sources or decide whether a Manager should select a payload.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_OBJECT_SCHEMA, payloadIdFor, payloadObjectDir, payloadObjectManifestPath, readPayloadLedger,
  recordPayloads, sharedStore,
} from '../registry.mjs';
import { assertTransferFiles, stageFilePath, verifyStagedFiles } from './staging.mjs';
import { withPayloadLocks } from './lock.mjs';

const errorWithCode = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const readObjectManifest = (payloadId) => {
  try { return JSON.parse(fs.readFileSync(payloadObjectManifestPath(payloadId), 'utf8')); }
  catch { return null; }
};

const objectMatches = (payloadId, files) => {
  const expected = payloadIdFor(files);
  if (expected !== payloadId) return { ok: false, error: 'payload_id_mismatch' };
  const metadata = readObjectManifest(payloadId);
  if (!metadata || metadata.payload_id !== payloadId || metadata.schema !== PAYLOAD_OBJECT_SCHEMA) {
    return { ok: false, error: 'payload_object_corrupt' };
  }
  const root = payloadObjectDir(payloadId);
  const verified = verifyStagedFiles(files, root);
  return verified.ok ? { ok: true, metadata } : { ok: false, error: 'payload_object_corrupt', detail: verified.detail };
};

const legacyPath = (value) => {
  if (typeof value !== 'string' || !value) throw errorWithCode('legacy_storage_path_required', 'legacy payload needs a storage path');
  const root = path.resolve(sharedStore());
  const target = path.resolve(value);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw errorWithCode('payload_outside_shared_store', 'legacy payload storage path must stay inside the shared store');
  }
  return target;
};

const legacyMatches = (root, files) => {
  if (!fs.existsSync(root)) return { exists: false };
  if (!fs.statSync(root).isDirectory()) return { exists: true, ok: false, error: 'legacy_payload_conflict' };
  const verified = verifyStagedFiles(files, root);
  return verified.ok ? { exists: true, ok: true, reused: true } : {
    exists: true, ok: false, error: 'legacy_payload_conflict', detail: verified.detail,
  };
};

const safeMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    if (/token|secret|authorization|cookie|password/i.test(key)) return false;
    return ['string', 'number', 'boolean'].includes(typeof item) || item === null;
  }));
};

/** Move several verified stage directories into the object store, then update the Ledger once. */
export function commitStagedPayloads({ payloads = [], expectedGeneration = undefined } = {}) {
  if (!Array.isArray(payloads) || !payloads.length) throw errorWithCode('payload_records_required', 'at least one staged payload is required');
  const lockIds = payloads.map((item = {}) => payloadIdFor(assertTransferFiles(item.files)));
  return withPayloadLocks(lockIds, () => {
    const prepared = payloads.map((item = {}) => {
      const normalized = assertTransferFiles(item.files);
      const id = item.payloadId ?? payloadIdFor(normalized);
      if (id !== payloadIdFor(normalized)) throw errorWithCode('payload_id_mismatch', 'payload id does not match staged file manifest');
      const verified = verifyStagedFiles(normalized, item.stageRoot);
      if (!verified.ok) throw errorWithCode('staged_payload_invalid', verified.detail, verified);
      const layout = item.layout ?? 'object';
      if (!['object', 'legacy'].includes(layout)) throw errorWithCode('payload_layout_invalid', `unknown payload layout: ${layout}`);
      return { ...item, files: normalized, id, layout, objectRoot: payloadObjectDir(id), reused: false };
    });
    for (const item of prepared) {
      if (item.layout === 'legacy') {
        item.storageRoot = legacyPath(item.storagePath);
        const existing = legacyMatches(item.storageRoot, item.files);
        if (existing.exists && !existing.ok) throw errorWithCode('legacy_payload_conflict', `legacy payload ${item.id} exists but does not verify`, existing);
        item.reused = existing.reused === true;
      } else if (fs.existsSync(item.objectRoot)) {
        const existing = objectMatches(item.id, item.files);
        if (!existing.ok) throw errorWithCode('payload_object_conflict', `content-addressed object ${item.id} exists but does not verify`, existing);
        item.reused = true;
      }
    }
    // Several Declarations may intentionally select the same immutable object.
    // The preflight above runs before any rename, so two records with one
    // payload id would otherwise both observe an absent destination and the
    // second rename would fail with EEXIST. Treat later identical destinations
    // as a safe reuse; record all Selections in the single Ledger mutation below.
    const destinations = new Map();
    for (const item of prepared) {
      const destination = item.layout === 'legacy' ? item.storageRoot : item.objectRoot;
      const previous = destinations.get(destination);
      if (previous) {
        if (previous.id !== item.id || previous.layout !== item.layout) {
          throw errorWithCode('payload_layout_conflict', `one destination was requested for different payload identities: ${destination}`);
        }
        item.reused = true;
      } else destinations.set(destination, item);
    }
    const recordsFor = (items, { select = true, orphan = false, reason = null } = {}) => items.map((item) => ({
      payloadId: item.id,
      files: item.files,
      storagePath: item.layout === 'legacy' ? item.storageRoot : item.objectRoot,
      layout: item.layout,
      selection: select ? (item.selection ?? null) : null,
      ...safeMetadata(item.metadata),
      ...(orphan ? { orphan: true, orphan_reason: reason ?? 'commit_failed' } : {}),
    }));
    const recordLandedOrphans = (items, reason) => {
      if (!items.length) return [];
      const current = readPayloadLedger();
      if (current.error) return [];
      try {
        const result = recordPayloads(recordsFor(items, { select: false, orphan: true, reason }), {
          expectedGeneration: current.generation,
        });
        return result.records.map((item) => item.payload.payload_id);
      } catch { return []; }
    };
    const landed = [];
    for (const item of prepared) {
      if (item.reused) {
        fs.rmSync(item.stageRoot, { recursive: true, force: true });
        continue;
      }
      const destination = item.layout === 'legacy' ? item.storageRoot : item.objectRoot;
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (item.layout === 'object') {
        const manifest = {
          schema: PAYLOAD_OBJECT_SCHEMA,
          payload_id: item.id,
          files: item.files,
          metadata: safeMetadata(item.metadata),
          created_at: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(item.stageRoot, '.payload.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      }
      try {
        fs.renameSync(item.stageRoot, destination);
        landed.push(item);
      } catch (error) {
        const orphanPayloads = recordLandedOrphans(landed, error?.code ?? 'commit_rename_failed');
        if (orphanPayloads.length) error.orphan_payloads = orphanPayloads;
        throw error;
      }
    }
    const records = recordsFor(prepared);
    let recorded;
    try {
      recorded = recordPayloads(records, { expectedGeneration });
    } catch (error) {
      // The rename above is already durable.  A stale CAS must never switch
      // another caller's Selection, but it also must not leave a physically
      // complete object outside the inventory forever.  Record every landed
      // object as an unselected orphan against the current generation, then
      // rethrow the original conflict for the caller to retry explicitly.
      const current = readPayloadLedger();
      if (!current.error) {
        try {
          error.orphan_payloads = recordLandedOrphans(landed, error?.code ?? 'ledger_commit_failed');
        } catch { /* the original error remains authoritative */ }
      }
      throw error;
    }
    return {
      ok: true,
      verified: true,
      ledger: recorded.ledger,
      payloads: prepared.map((item, index) => ({
        payload_id: item.id, path: item.layout === 'legacy' ? item.storageRoot : item.objectRoot, reused: item.reused,
        payload: recorded.records[index].payload, selection: recorded.records[index].selection,
      })),
    };
  });
}

/** Move one verified stage directory into the object store, then update Ledger. */
export function commitStagedPayload(options = {}) {
  const result = commitStagedPayloads({ payloads: [options], expectedGeneration: options.expectedGeneration });
  const one = result.payloads[0];
  return { ok: true, payload_id: one.payload_id, path: one.path, reused: one.reused, verified: true,
    ledger: result.ledger, payload: one.payload, selection: one.selection };
}

export const inspectPayloadObject = (payloadId, files) => objectMatches(payloadId, assertTransferFiles(files));

// ============================================================
// Self-test: node src/assets/transfer/commit.mjs --self-test
// ============================================================
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-commit-'));
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
  const body = Buffer.from('object bytes');
  const crypto = await import('node:crypto');
  const files = [{ path: 'model.bin', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), role: 'model' }];
  const stage = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'op-1');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'model.bin'), body);
  const result = commitStagedPayload({ files, stageRoot: stage, selection: { asset_id: 'model.raw', variant_id: 'generic' }, metadata: { source_kind: 'fixture' } });
  test('verified stage becomes a content-addressed object', result.ok && fs.existsSync(result.path) && result.payload_id === payloadIdFor(files));
  test('selection is written separately from the declaration', result.selection?.payload_id === result.payload_id);
  const again = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'op-2');
  fs.mkdirSync(again, { recursive: true });
  fs.writeFileSync(path.join(again, 'model.bin'), body);
  const reused = commitStagedPayload({ files, stageRoot: again });
  test('same bytes reuse the object without changing identity', reused.reused === true && reused.payload_id === result.payload_id);
  const sharedA = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'op-shared-a');
  const sharedB = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'op-shared-b');
  for (const dir of [sharedA, sharedB]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'model.bin'), body); }
  const shared = commitStagedPayloads({ payloads: [
    { files, stageRoot: sharedA }, { files, stageRoot: sharedB },
  ] });
  test('one transfer can attach several Selections to the same object', shared.payloads.length === 2
    && shared.payloads[0].payload_id === shared.payloads[1].payload_id
    && shared.payloads[1].reused === true && fs.existsSync(shared.payloads[0].path));

  const firstAfterBody = Buffer.from('first object after shared bytes');
  const firstAfterFiles = [{ path: 'first.bin', size: firstAfterBody.length,
    sha256: crypto.createHash('sha256').update(firstAfterBody).digest('hex') }];
  const firstAfterId = payloadIdFor(firstAfterFiles);
  const secondBody = Buffer.from('second object bytes');
  const secondFiles = [{ path: 'second.bin', size: secondBody.length,
    sha256: crypto.createHash('sha256').update(secondBody).digest('hex') }];
  const secondId = payloadIdFor(secondFiles);
  const firstAfterShared = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'op-rename-first');
  const secondAfterShared = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'op-rename-second');
  fs.mkdirSync(firstAfterShared, { recursive: true });
  fs.writeFileSync(path.join(firstAfterShared, 'first.bin'), firstAfterBody);
  fs.mkdirSync(secondAfterShared, { recursive: true });
  fs.writeFileSync(path.join(secondAfterShared, 'second.bin'), secondBody);
  const originalRename = fs.renameSync;
  let renameFailure = null;
  try {
    fs.renameSync = (from, to) => {
      if (path.resolve(to) === path.resolve(payloadObjectDir(secondId))) {
        throw Object.assign(new Error('fixture rename interruption'), { code: 'fixture_rename_interrupted' });
      }
      return originalRename(from, to);
    };
    try {
      commitStagedPayloads({ payloads: [
        { files: firstAfterFiles, stageRoot: firstAfterShared }, { files: secondFiles, stageRoot: secondAfterShared },
      ] });
    } catch (error) { renameFailure = error; }
  } finally { fs.renameSync = originalRename; }
  const afterRenameFailure = (await import('../registry.mjs')).readPayloadLedger();
  test('a rename interruption inventories the already-landed object as an orphan', renameFailure?.code === 'fixture_rename_interrupted'
    && renameFailure.orphan_payloads?.includes(firstAfterId)
    && afterRenameFailure.payloads?.[firstAfterId]?.orphan === true
    && afterRenameFailure.selections?.[`${'model.raw'}\u0000generic`]?.payload_id === result.payload_id);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
