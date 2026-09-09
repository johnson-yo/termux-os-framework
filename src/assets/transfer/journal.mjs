/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Generic Asset operation identity, file metadata, and lifecycle state.
 * [OUTPUT]: Atomic, restart-visible operation journals with no credentials or raw source headers.
 * [POS]: src/assets/transfer/journal.mjs in termux-os-framework.
 * [PROTOCOL]: Journals describe mechanics and recovery, never Manager source or product policy.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_OBJECT_SCHEMA, payloadIdFor, payloadObjectDir, payloadObjectManifestPath,
  readPayloadLedger, recordPayload, registryDir,
} from '../registry.mjs';
import { assertTransferFiles, verifyStagedFiles } from './staging.mjs';

export const operationDir = () => process.env.ASSET_OPERATIONS_DIR || path.join(registryDir(), 'operations');

const safeId = (id) => /^[A-Za-z0-9._-]+$/.test(String(id ?? ''));
const operationPath = (id) => {
  if (!safeId(id)) throw new Error('asset operation id is invalid');
  return path.join(operationDir(), `${id}.json`);
};

const nowIso = () => new Date().toISOString();

export const OPERATION_STATES = Object.freeze(['created', 'running', 'staged', 'committing', 'complete', 'failed', 'cancelled', 'interrupted']);

const unsafeMetadataKey = /token|secret|authorization|cookie|password|url|uri|header/i;
const safeMetadataValue = (value, depth = 0) => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (depth >= 3 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.map((item) => safeMetadataValue(item, depth + 1)).filter((item) => item !== undefined);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !unsafeMetadataKey.test(key))
    .map(([key, item]) => [key, safeMetadataValue(item, depth + 1)])
    .filter(([, item]) => item !== undefined));
};

const safeMetadata = (value) => {
  const sanitized = safeMetadataValue(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
};

const write = (operation) => {
  const target = operationPath(operation.operation_id);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(operation, null, 2)}\n`, { mode: 0o600 });
    const fd = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    try {
      const dir = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { /* directory fsync is not available on every Android filesystem */ }
  } finally { fs.rmSync(temporary, { force: true }); }
  return operation;
};

export function createOperation({
  type = 'transfer', assetId = null, variantId = 'generic', files = [], expectedGeneration = null,
  stageRoot = null, selection = false, metadata = {}, operationId = null,
  idempotencyKey = null, requester = null,
} = {}) {
  const id = operationId ?? `assetop_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  if (!safeId(id)) throw new Error('asset operation id is invalid');
  const operation = {
    schema: 'termux-os.asset-operation.v2',
    operation_id: id,
    type,
    asset_id: assetId,
    variant_id: variantId || 'generic',
    files: Array.isArray(files) ? files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256, role: file.role ?? null })) : [],
    expected_generation: expectedGeneration,
    idempotency_key: typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : null,
    requester: requester && typeof requester === 'object' ? {
      kind: requester.kind ?? null,
      package_id: requester.package_id ?? null,
      generation: requester.generation ?? null,
    } : null,
    stage_root: stageRoot,
    select: selection === true,
    metadata: safeMetadata(metadata),
    state: 'created',
    created_at: nowIso(),
    updated_at: nowIso(),
    bytes_done: 0,
    bytes_total: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
    error: null,
    result: null,
    // Populated and fsynced immediately before the staging directory is
    // renamed. It contains no URL or credential, only enough facts to finish
    // an already-landed object after a process dies in the commit window.
    commit_intent: null,
  };
  return write(operation);
}

/** Find an existing operation before creating a duplicate for the same request. */
export function findOperationByIdempotency(idempotencyKey, requester = null) {
  if (!idempotencyKey) return null;
  return listOperations({ limit: 1000 }).find((operation) => operation.idempotency_key === idempotencyKey
    && (!requester || (operation.requester?.kind ?? null) === (requester.kind ?? null)
      && (operation.requester?.package_id ?? null) === (requester.package_id ?? null))) ?? null;
}

export function readOperation(id) {
  try { return JSON.parse(fs.readFileSync(operationPath(id), 'utf8')); }
  catch (error) { return error?.code === 'ENOENT' ? null : { operation_id: id, state: 'failed', error: `operation journal unreadable: ${String(error?.message ?? error)}` }; }
}

export function updateOperation(id, patch = {}) {
  const current = readOperation(id);
  if (!current) throw new Error(`unknown asset operation: ${id}`);
  const next = { ...current, ...patch, operation_id: current.operation_id, updated_at: nowIso() };
  if (next.state && !OPERATION_STATES.includes(next.state)) throw new Error(`unknown asset operation state: ${next.state}`);
  return write(next);
}

export function listOperations({ limit = 100 } = {}) {
  let files = [];
  try { files = fs.readdirSync(operationDir()).filter((name) => name.endsWith('.json')).sort().reverse(); } catch { return []; }
  return files.slice(0, Math.max(1, Number(limit) || 100)).map((name) => readOperation(name.slice(0, -5))).filter(Boolean);
}

const safeCommitIntent = (intent) => {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null;
  let files;
  try { files = assertTransferFiles(intent.files).map(({ path: relative, size, sha256, role }) => ({ path: relative, size, sha256, ...(role ? { role } : {}) })); }
  catch { return null; }
  const payloadId = String(intent.payload_id ?? '');
  if (!/^[0-9a-f]{64}$/i.test(payloadId) || payloadIdFor(files) !== payloadId.toLowerCase()) return null;
  if (intent.layout !== undefined && intent.layout !== 'object') return null;
  const storagePath = payloadObjectDir(payloadId);
  if (typeof intent.storage_path === 'string' && path.resolve(intent.storage_path) !== path.resolve(storagePath)) return null;
  const selection = intent.selection && typeof intent.selection === 'object'
    ? {
      asset_id: String(intent.selection.asset_id ?? ''),
      variant_id: String(intent.selection.variant_id ?? 'generic'),
      ...(typeof intent.selection.source === 'string' ? { source: intent.selection.source } : {}),
    }
    : null;
  if (selection && !selection.asset_id) return null;
  const metadata = safeMetadata(intent.metadata);
  return {
    schema: 'termux-os.asset-commit-intent.v2',
    payload_id: payloadId.toLowerCase(),
    layout: 'object',
    storage_path: storagePath,
    files,
    selection,
    metadata,
    expected_generation: intent.expected_generation == null ? null : Number(intent.expected_generation),
  };
};

const objectIsComplete = (intent) => {
  const root = payloadObjectDir(intent.payload_id);
  try {
    const manifest = JSON.parse(fs.readFileSync(payloadObjectManifestPath(intent.payload_id), 'utf8'));
    if (manifest?.schema !== PAYLOAD_OBJECT_SCHEMA || manifest.payload_id !== intent.payload_id) return false;
  } catch { return false; }
  return verifyStagedFiles(intent.files, root).ok;
};

const selectionMatches = (ledger, intent) => {
  if (!intent.selection) return true;
  const key = `${intent.selection.asset_id}\u0000${intent.selection.variant_id}`;
  return ledger.selections?.[key]?.payload_id === intent.payload_id;
};

const recoveredCommit = (operation) => {
  const intent = safeCommitIntent(operation.commit_intent);
  if (!intent || !objectIsComplete(intent)) return null;
  const ledger = readPayloadLedger();
  if (ledger.error) return {
    state: 'interrupted', stage: 'committing', error: 'commit_reconcile_ledger_corrupt',
    error_code: 'payload_ledger_corrupt',
  };
  const existing = ledger.payloads?.[intent.payload_id];
  const existingCompatible = existing && existing.state !== 'deleting'
    && payloadIdFor(existing.files) === intent.payload_id;
  if (existingCompatible && selectionMatches(ledger, intent)) {
    return {
      state: 'complete', stage: 'committed', bytes_done: operation.bytes_total,
      error: null, error_code: null,
      result: { payload_id: intent.payload_id, path: existing.storage_path, reused: true, reconciled: true },
    };
  }
  // A concurrent mutation may have advanced the Ledger while this process was
  // down. Never overwrite that newer decision while attempting recovery. The
  // object remains an unselected, verifiable orphan for a later Manager action.
  if (intent.expected_generation !== null && ledger.generation !== intent.expected_generation) {
    let orphanRecorded = false;
    try {
      const orphan = recordPayload({
        payloadId: intent.payload_id,
        files: intent.files,
        storagePath: intent.storage_path,
        layout: 'object',
        orphan: true,
        orphan_reason: 'generation_mismatch_during_commit_reconcile',
        expectedGeneration: ledger.generation,
      });
      orphanRecorded = orphan?.payload?.payload_id === intent.payload_id;
    } catch { /* preserve the recovery conflict; the object remains diagnosable */ }
    return {
      state: 'interrupted', stage: 'committing',
      error: 'commit intent found a newer Ledger generation; retry the operation explicitly',
      error_code: 'generation_mismatch',
      result: {
        payload_id: intent.payload_id, path: payloadObjectDir(intent.payload_id), orphan: true,
        orphan_recorded: orphanRecorded, reconciled: true,
      },
    };
  }
  try {
    const committed = recordPayload({
      payloadId: intent.payload_id,
      files: intent.files,
      storagePath: intent.storage_path,
      layout: 'object',
      selection: intent.selection,
      ...intent.metadata,
    });
    return {
      state: 'complete', stage: 'committed', bytes_done: operation.bytes_total,
      error: null, error_code: null,
      result: { payload_id: intent.payload_id, path: committed.payload.storage_path, reused: true, reconciled: true },
    };
  } catch (error) {
    let orphanRecorded = false;
    try {
      const current = readPayloadLedger();
      if (!current.error) {
        const orphan = recordPayload({
          payloadId: intent.payload_id,
          files: intent.files,
          storagePath: intent.storage_path,
          layout: 'object',
          selection: null,
          orphan: true,
          orphan_reason: error?.code ?? 'commit_reconcile_failed',
          expectedGeneration: current.generation,
        });
        orphanRecorded = orphan?.payload?.payload_id === intent.payload_id;
      }
    } catch { /* preserve the original reconciliation error */ }
    return {
      state: 'interrupted', stage: 'committing',
      error: `commit reconciliation could not update the Ledger: ${String(error?.message ?? error)}`,
      error_code: error?.code ?? 'commit_reconcile_failed',
      result: { payload_id: intent.payload_id, path: payloadObjectDir(intent.payload_id), orphan: true, orphan_recorded: orphanRecorded, reconciled: true },
    };
  }
};

/** Recover only a proven commit; other in-flight work remains explicitly resumable. */
export function reconcileOperations() {
  const changed = [];
  for (const operation of listOperations({ limit: 1000 })) {
    if (!['running', 'staged', 'committing'].includes(operation.state)) continue;
    if (operation.state === 'committing') {
      const recovery = recoveredCommit(operation);
      if (recovery) {
        changed.push(updateOperation(operation.operation_id, recovery));
        continue;
      }
    }
    changed.push(updateOperation(operation.operation_id, {
      state: 'interrupted',
      error: 'process_restarted; operation can be resumed explicitly',
    }));
  }
  return changed;
}

// ============================================================
// Self-test: node src/assets/transfer/journal.mjs --self-test
// ============================================================
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-journal-'));
  process.env.ASSET_OPERATIONS_DIR = path.join(root, 'operations');
  process.env.ASSETS_REGISTRY_DIR = path.join(root, 'registry');
  process.env.SHARED_ASSET_STORE = path.join(root, 'store');
  const operation = createOperation({ assetId: 'model.raw', idempotencyKey: 'fixture-1', requester: { kind: 'package', package_id: 'pkg.manager', generation: 'g1' }, files: [{ path: 'model.bin', size: 2, sha256: 'a'.repeat(64) }], metadata: { source_kind: 'fixture', authorization: 'Bearer should-not-persist', nested: { safe: 'kept', cookie: 'also-hidden' } } });
  const persisted = readOperation(operation.operation_id);
  test('operation is persisted without raw request headers', readOperation(operation.operation_id)?.state === 'created'
    && readOperation(operation.operation_id)?.idempotency_key === 'fixture-1'
    && persisted?.metadata?.source_kind === 'fixture'
    && persisted?.metadata?.nested?.safe === 'kept'
    && !JSON.stringify(persisted).includes('should-not-persist')
    && !JSON.stringify(persisted).includes('also-hidden'));
  test('idempotency resolves to the same journal', findOperationByIdempotency('fixture-1', { kind: 'package', package_id: 'pkg.manager', generation: 'g1' })?.operation_id === operation.operation_id);
  test('a reloaded Manager can resume its package journal', findOperationByIdempotency('fixture-1', { kind: 'package', package_id: 'pkg.manager', generation: 'g2' })?.operation_id === operation.operation_id);
  updateOperation(operation.operation_id, { state: 'running' });
  test('restart reconciliation leaves a resumable journal', reconcileOperations()[0]?.state === 'interrupted');
  test('operation listing is deterministic', listOperations().some((item) => item.operation_id === operation.operation_id));

  const installed = path.join(root, 'packages', 'pkg.asset', 'versions', '1.0.0');
  process.env.PACKAGES_INSTALLED_DIR = path.join(root, 'packages');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'pkg.asset', 'active.json'), `${JSON.stringify({
    schema: 'termux-os.package-active.v1', id: 'pkg.asset', active_version: '1.0.0',
  })}\n`);
  fs.writeFileSync(path.join(installed, 'termux-os.package.json'), `${JSON.stringify({
    schema: 'termux-os.package.v1', id: 'pkg.asset', version: '1.0.0', assets: {
      provides: [{ id: 'model.raw', kind: 'model', payload: 'raw', files: { model: 'model.bin' } }],
    },
  })}\n`);
  const body = Buffer.from('recovered object');
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const commitFiles = [{ path: 'model.bin', size: body.length, sha256: hash, role: 'model' }];
  const commitPayloadId = payloadIdFor(commitFiles);
  const objectRoot = payloadObjectDir(commitPayloadId);
  fs.mkdirSync(objectRoot, { recursive: true });
  fs.writeFileSync(path.join(objectRoot, 'model.bin'), body);
  fs.writeFileSync(payloadObjectManifestPath(commitPayloadId), `${JSON.stringify({
    schema: PAYLOAD_OBJECT_SCHEMA, payload_id: commitPayloadId, files: commitFiles,
  })}\n`);
  const interruptedCommit = createOperation({ assetId: 'model.raw', files: commitFiles, selection: true });
  updateOperation(interruptedCommit.operation_id, {
    state: 'committing',
    commit_intent: {
      schema: 'termux-os.asset-commit-intent.v2', payload_id: commitPayloadId,
      storage_path: objectRoot, files: commitFiles,
      selection: { asset_id: 'model.raw', variant_id: 'generic' }, expected_generation: 0,
    },
  });
  const recovered = reconcileOperations().find((item) => item.operation_id === interruptedCommit.operation_id);
  test('commit intent reconciles a landed object into Ledger and Selection', recovered?.state === 'complete'
    && readPayloadLedger().payloads?.[commitPayloadId]?.state === 'ready'
    && readPayloadLedger().selections?.['model.raw\u0000generic']?.payload_id === commitPayloadId
    && recovered.result?.reconciled === true);

  const racedBody = Buffer.from('raced orphan object');
  const racedHash = crypto.createHash('sha256').update(racedBody).digest('hex');
  const racedFiles = [{ path: 'model.bin', size: racedBody.length, sha256: racedHash, role: 'model' }];
  const racedPayloadId = payloadIdFor(racedFiles);
  const racedRoot = payloadObjectDir(racedPayloadId);
  fs.mkdirSync(racedRoot, { recursive: true });
  fs.writeFileSync(path.join(racedRoot, 'model.bin'), racedBody);
  fs.writeFileSync(payloadObjectManifestPath(racedPayloadId), `${JSON.stringify({
    schema: PAYLOAD_OBJECT_SCHEMA, payload_id: racedPayloadId, files: racedFiles,
  })}\n`);
  const racedOperation = createOperation({ assetId: 'model.raw', files: racedFiles, selection: true, expectedGeneration: 0 });
  updateOperation(racedOperation.operation_id, {
    state: 'committing',
    commit_intent: {
      schema: 'termux-os.asset-commit-intent.v2', payload_id: racedPayloadId,
      storage_path: racedRoot, files: racedFiles,
      selection: { asset_id: 'model.raw', variant_id: 'generic' }, expected_generation: 0,
    },
  });
  const raced = reconcileOperations().find((item) => item.operation_id === racedOperation.operation_id);
  const racedLedger = readPayloadLedger();
  test('newer Ledger generation preserves Selection and records a reconciled orphan', raced?.state === 'interrupted'
    && raced.result?.orphan_recorded === true
    && racedLedger.selections?.['model.raw\u0000generic']?.payload_id === commitPayloadId
    && racedLedger.payloads?.[racedPayloadId]?.orphan === true);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
