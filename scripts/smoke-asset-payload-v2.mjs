#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Temporary active Package manifests and synthetic explicit transfer/archive bytes.
 * [OUTPUT]: A deterministic local acceptance run for Declaration, Payload, Selection, and orphan lifecycle facts.
 * [POS]: scripts/smoke-asset-payload-v2.mjs in termux-os-framework.
 * [PROTOCOL]: This smoke never contacts a source or device; every URL is a fixture coordinate consumed by generic Core transfer code.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-payload-v2-smoke-'));
process.env.PACKAGES_INSTALLED_DIR = path.join(root, 'packages');
process.env.SHARED_ASSET_STORE = path.join(root, 'models');
process.env.ASSETS_REGISTRY_DIR = path.join(root, 'registry');
process.env.ASSET_PAYLOAD_LEDGER_PATH = path.join(root, 'registry', 'payloads.v2.json');
process.env.ASSET_OPERATIONS_DIR = path.join(root, 'registry', 'operations');

const tests = [];
const test = (name, condition) => tests.push({ name, condition: Boolean(condition) });
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

try {
  const {
    readDeclarationIndex,
  } = await import('../src/assets/declarations.mjs');
  const {
    payloadIdFor, readPayloadLedger, listPayloadRecords, listSelectionRecords,
    setPayloadSelection, recordPayloads,
  } = await import('../src/assets/registry.mjs');
  const { stagePullFiles } = await import('../src/assets/transfer/staging.mjs');
  const { commitStagedPayloads } = await import('../src/assets/transfer/commit.mjs');
  const { deleteImpact, deletePayload } = await import('../src/assets/transfer/removal.mjs');
  const { resolveAssetV2 } = await import('../src/assets/resolver.mjs');
  const { importAssetArchiveV2, ASSET_ARCHIVE_MANIFEST, ASSET_ARCHIVE_SCHEMA } = await import('../src/assets/archive.mjs');

  const packageId = 'github.termux-os.fixture.asset-lifecycle';
  const version = '1.0.0';
  const versionRoot = path.join(process.env.PACKAGES_INSTALLED_DIR, packageId, 'versions', version);
  writeJson(path.join(process.env.PACKAGES_INSTALLED_DIR, packageId, 'active.json'), {
    schema: 'termux-os.package-active.v1', id: packageId, active_version: version,
  });
  writeJson(path.join(versionRoot, 'termux-os.package.json'), {
    schema: 'termux-os.package.v1', id: packageId, version,
    assets: { provides: [
      { id: 'model.required', kind: 'model', payload: 'required', files: { model: 'model.bin' } },
      { id: 'model.optional', kind: 'model', optional: true, payload: 'optional', files: { model: 'model.bin' } },
    ] },
  });

  const profile = { os: 'linux', arch: 'x86_64' };
  const index = readDeclarationIndex();
  test('active Package derives required and optional Declarations', index.declarations.length === 2
    && index.declarations.some((item) => item.asset_id === 'model.required' && item.optional === false)
    && index.declarations.some((item) => item.asset_id === 'model.optional' && item.optional === true));

  const body = Buffer.from('shared payload bytes');
  const sourceUrl = 'https://fixture.invalid/shared/model.bin';
  const file = { path: 'model.bin', role: 'model', size: body.length, sha256: digest(body), url: sourceUrl };
  const fetchImpl = async (url, options = {}) => {
    const range = String(options.headers?.Range ?? '').match(/^bytes=(\d+)-$/);
    const offset = range ? Number(range[1]) : 0;
    return {
      ok: true,
      status: offset ? 206 : 200,
      body: (async function* stream() { yield body.subarray(offset); }()),
    };
  };
  const stage = async (name) => {
    const stageRoot = path.join(process.env.SHARED_ASSET_STORE, '.staging', name);
    await stagePullFiles([file], stageRoot, { fetchImpl, maxAttempts: 1 });
    return stageRoot;
  };

  const sharedPayload = commitStagedPayloads({ payloads: [
    { files: [file], stageRoot: await stage('required'), selection: { asset_id: 'model.required', variant_id: 'generic' },
      metadata: { package_id: packageId, version, provenance: 'package_install' } },
    { files: [file], stageRoot: await stage('optional'), selection: { asset_id: 'model.optional', variant_id: 'generic' },
      metadata: { package_id: packageId, version, provenance: 'package_install' } },
  ] });
  const payloadId = sharedPayload.payloads[0].payload_id;
  let ledger = readPayloadLedger();
  test('required and optional use the same verified transfer/commit path', sharedPayload.ok
    && sharedPayload.payloads.length === 2 && sharedPayload.payloads[1].reused === true
    && listPayloadRecords(ledger).length === 1 && listSelectionRecords(ledger).length === 2);
  test('Declaration optionality and absent runtime provider do not gate resolution',
    resolveAssetV2('model.required', { profile }).ready === true
    && resolveAssetV2('model.optional', { profile }).ready === true);

  const impact = deleteImpact(payloadId, {
    ledger, declarations: index.declarations, consumers: [{ package_id: 'consumer.example', path: '.models/model' }],
    runtime: { loaded: true, note: 'observation only' },
  });
  test('delete impact reports provenance, shared Selections, consumers, and runtime facts', impact.package_provisioned === true
    && impact.selected_by.length === 2 && impact.declarations.length === 2 && impact.consumers.length === 1
    && impact.runtime.loaded === true && impact.can_delete === true);
  const blocked = deletePayload(payloadId, { expectedGeneration: ledger.generation, detach: ['model.required\u0000generic'] });
  test('shared payload deletion requires the exact current Selection set', blocked.error === 'selection_detach_required'
    && blocked.selected_by.length === 2);
  const detached = deletePayload(payloadId, {
    expectedGeneration: ledger.generation,
    detach: ['model.required\u0000generic', 'model.optional\u0000generic'],
  });
  ledger = readPayloadLedger();
  test('confirmed deletion clears Selection and keeps Declaration', detached.ok
    && resolveAssetV2('model.required', { profile }).reason === 'payload_missing:model.required'
    && resolveAssetV2('model.optional', { profile }).reason === 'payload_missing:model.optional'
    && readDeclarationIndex().declarations.length === 2);

  const restoredStage = await stage('restored');
  const restored = commitStagedPayloads({ payloads: [{ files: [file], stageRoot: restoredStage,
    selection: { asset_id: 'model.required', variant_id: 'generic' }, metadata: { provenance: 'manager_transfer' } }] });
  ledger = readPayloadLedger();
  const selectedOptional = setPayloadSelection('model.optional', 'generic', restored.payloads[0].payload_id, {
    expectedGeneration: ledger.generation,
  });
  test('a later Manager transfer can restore and reselect deleted bytes', selectedOptional.selection?.payload_id === payloadId
    && resolveAssetV2('model.required', { profile }).ready === true
    && resolveAssetV2('model.optional', { profile }).ready === true);

  // Advance the Ledger after the Manager captured its expected generation.
  // The staged replacement may land as an orphan, but a failed CAS must never
  // switch the currently usable Selection to that replacement.
  const updateBytes = Buffer.from('replacement payload bytes');
  const updateFile = { ...file, size: updateBytes.length, sha256: digest(updateBytes) };
  const updateStage = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'failed-update');
  await stagePullFiles([updateFile], updateStage, {
    fetchImpl: async () => ({ ok: true, status: 200, body: (async function* stream() { yield updateBytes; }()) }),
    maxAttempts: 1,
  });
  const expectedBeforeRace = readPayloadLedger().generation;
  setPayloadSelection('model.optional', 'generic', payloadId, { expectedGeneration: expectedBeforeRace });
  let updateFailed = null;
  try {
    commitStagedPayloads({ payloads: [{ files: [updateFile], stageRoot: updateStage,
      selection: { asset_id: 'model.required', variant_id: 'generic' } }], expectedGeneration: expectedBeforeRace });
  } catch (error) { updateFailed = error; }
  ledger = readPayloadLedger();
  test('a failed update CAS preserves the old Selections', updateFailed?.code === 'generation_mismatch'
    && ledger.selections?.['model.required\u0000generic']?.payload_id === payloadId
    && ledger.selections?.['model.optional\u0000generic']?.payload_id === payloadId
    && listPayloadRecords(ledger).some((item) => item.payload_id === payloadIdFor([updateFile])
      && item.orphan === true && item.orphan_reason === 'generation_mismatch'));

  const orphanBytes = Buffer.from('orphan bytes');
  const orphanFiles = [{ path: 'orphan.bin', size: orphanBytes.length, sha256: digest(orphanBytes), role: 'model' }];
  const orphanStage = path.join(process.env.SHARED_ASSET_STORE, '.staging', 'orphan');
  fs.mkdirSync(orphanStage, { recursive: true });
  fs.writeFileSync(path.join(orphanStage, 'orphan.bin'), orphanBytes);
  const orphan = commitStagedPayloads({ payloads: [{ files: orphanFiles, stageRoot: orphanStage,
    metadata: { source_kind: 'fixture_orphan' } }] });
  ledger = readPayloadLedger();
  test('an imported/committed orphan is listed but cannot become a resolved Asset', orphan.ok
    && listPayloadRecords(ledger).some((item) => item.payload_id === orphan.payloads[0].payload_id)
    && resolveAssetV2('asset.never.declared', { profile }).registration_state === 'unregistered');
  const orphanDeleted = deletePayload(orphan.payloads[0].payload_id, { expectedGeneration: ledger.generation, detach: [] });
  test('an orphan can be deleted without a fake Declaration or Selection', orphanDeleted.ok);

  const archiveBytes = Buffer.from('archive orphan bytes');
  const archiveSha = digest(archiveBytes);
  const archiveSource = path.join(root, 'archive-source');
  fs.mkdirSync(path.join(archiveSource, 'payload', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(archiveSource, 'payload', 'archive', 'archive.bin'), archiveBytes);
  writeJson(path.join(archiveSource, ASSET_ARCHIVE_MANIFEST), {
    schema: ASSET_ARCHIVE_SCHEMA, package_id: 'fixture.archive', version: '1.0.0', target: 'generic',
    assets: [{ id: 'asset.archive.orphan', payload: 'archive', files: [{ path: 'archive.bin', role: 'model', size: archiveBytes.length, sha256: archiveSha }] }],
  });
  const archivePath = path.join(root, 'archive.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', archiveSource, ASSET_ARCHIVE_MANIFEST, 'payload']);
  const imported = importAssetArchiveV2(archivePath, { store: process.env.SHARED_ASSET_STORE });
  ledger = readPayloadLedger();
  const importedId = imported.assets[0]?.payload_id;
  test('v2 archive import creates only an orphan Payload Object', imported.ok && importedId
    && !readDeclarationIndex().declarations.some((item) => item.asset_id === 'asset.archive.orphan')
    && !listSelectionRecords(ledger).some((item) => item.asset_id === 'asset.archive.orphan')
    && listPayloadRecords(ledger).some((item) => item.payload_id === importedId));
  const importedDeleted = deletePayload(importedId, { expectedGeneration: ledger.generation, detach: [] });
  test('archive orphan remains freely removable through the same Core delete primitive', importedDeleted.ok);

  const legacyPath = path.join(process.env.SHARED_ASSET_STORE, 'legacy', 'payload');
  const legacyBytes = Buffer.from('legacy tombstone bytes');
  const legacyFiles = [{ path: 'legacy.bin', size: legacyBytes.length, sha256: digest(legacyBytes), role: 'model' }];
  fs.mkdirSync(legacyPath, { recursive: true });
  fs.writeFileSync(path.join(legacyPath, 'legacy.bin'), legacyBytes);
  const legacyId = payloadIdFor(legacyFiles);
  recordPayloads([{ payloadId: legacyId, files: legacyFiles, storagePath: legacyPath, layout: 'legacy', metadata: { provenance: 'migration_fixture' } }]);
  // Simulate the file phase of a crashed tombstone; reconcile must finish it,
  // not turn the missing tracked file into a permanent deleting record.
  ledger = readPayloadLedger();
  fs.rmSync(path.join(legacyPath, 'legacy.bin'));
  const deleting = { ...ledger, payloads: { ...ledger.payloads, [legacyId]: { ...ledger.payloads[legacyId], state: 'deleting' } },
    tombstones: { ...ledger.tombstones, [legacyId]: { payload_id: legacyId, path: legacyPath } } };
  const { writePayloadLedger } = await import('../src/assets/registry.mjs');
  writePayloadLedger(deleting, { expectedGeneration: ledger.generation });
  const { reconcilePayloadDeletions } = await import('../src/assets/transfer/removal.mjs');
  const reconciled = reconcilePayloadDeletions();
  test('legacy deleting tombstone converges after a partial file removal', reconciled.ok
    && !readPayloadLedger().payloads[legacyId] && !fs.existsSync(legacyPath));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

for (const item of tests) console.log(`${item.condition ? 'PASS' : 'FAIL'} ${item.name}`);
const failures = tests.filter((item) => !item.condition).length;
console.log(`\n${tests.length - failures}/${tests.length} assertions passed`);
process.exit(failures ? 1 : 0);
