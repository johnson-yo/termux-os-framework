/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/assets/registry.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { declarationsForAsset, readDeclarationIndex } from './declarations.mjs';

export const REGISTRY_SCHEMA = 'termux-os.asset-registry.v1';
export const REGISTRY_FILENAME = 'registry.v1.json';
export const PAYLOAD_LEDGER_SCHEMA = 'termux-os.asset-payload-ledger.v2';
export const PAYLOAD_LEDGER_FILENAME = 'payloads.v2.json';
export const PAYLOAD_OBJECT_SCHEMA = 'termux-os.asset-payload-object.v2';

export const registryDir = () => process.env.ASSETS_REGISTRY_DIR
  || path.join(os.homedir(), '.termux-os/assets');
export const registryPath = () => path.join(registryDir(), REGISTRY_FILENAME);
export const payloadLedgerPath = () => process.env.ASSET_PAYLOAD_LEDGER_PATH
  || path.join(registryDir(), PAYLOAD_LEDGER_FILENAME);

/**
 * 共享 Model Store（024 §5）：模型統一在 /sdcard/termux-os/models；cache 另在相鄰 caches。
 * com.termux_os.app 讀不到 Termux 私有目錄。同一條 022 邊界仍在：只新建、不覆蓋既有內容。
 */
export const sharedStore = () => process.env.SHARED_ASSET_STORE || '/sdcard/termux-os/models';

/** 不可變版本目錄（§5）：<store>/<package-id>/<version>/<target>/ */
export const assetVersionDir = (packageId, version, target) => path.join(sharedStore(), packageId, version, target);

const hexDigest = (value) => /^[0-9a-f]{64}$/i.test(String(value ?? ''));

const operationError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const insideSharedStore = (value) => {
  const root = path.resolve(sharedStore());
  const target = path.resolve(String(value ?? ''));
  return target !== root && target.startsWith(`${root}${path.sep}`);
};

/** JSON with object keys sorted, used only for stable identity material. */
export const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));

const normalizeLedgerFiles = (files) => {
  if (!Array.isArray(files) || !files.length) throw operationError('payload_files_required', 'payload files are required');
  const seen = new Set();
  return files.map((file) => {
    const relative = String(file?.path ?? '');
    if (!relative || path.posix.isAbsolute(relative) || relative.includes('\\')
      || path.posix.normalize(relative) !== relative || relative.split('/').includes('..')) {
      throw operationError('payload_file_path_invalid', `payload file path is unsafe: ${relative}`);
    }
    if (seen.has(relative)) throw operationError('payload_file_duplicate', `payload file is repeated: ${relative}`);
    seen.add(relative);
    const size = Number(file?.size);
    const sha256 = String(file?.sha256 ?? '').toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || !hexDigest(sha256)) {
      throw operationError('payload_file_metadata_invalid', `payload file metadata is invalid: ${relative}`);
    }
    return {
      path: relative,
      size,
      sha256,
      ...(typeof file?.role === 'string' && file.role ? { role: file.role } : {}),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
};

/** Content identity is independent of Asset/Package/source policy. */
export function canonicalFileManifest(files) {
  return normalizeLedgerFiles(files).map(({ path: relative, size, sha256 }) => ({
    path: relative, size, sha256,
  }));
}

export function payloadIdFor(files) {
  return crypto.createHash('sha256').update(canonicalJson(canonicalFileManifest(files))).digest('hex');
}

export const payloadObjectDir = (payloadId) => {
  if (!hexDigest(payloadId)) throw operationError('payload_id_invalid', 'payload_id must be a SHA-256 digest');
  return path.join(sharedStore(), '.objects', 'sha256', String(payloadId).toLowerCase());
};

export const payloadObjectManifestPath = (payloadId) => path.join(payloadObjectDir(payloadId), '.payload.json');

export function emptyPayloadLedger() {
  return {
    schema: PAYLOAD_LEDGER_SCHEMA,
    generation: 0,
    payloads: {},
    selections: {},
    tombstones: {},
    updated_at: null,
  };
}

const normalizedLedger = (value) => {
  const isMap = (item) => item && typeof item === 'object' && !Array.isArray(item);
  if (!isMap(value) || !isMap(value.payloads) || !isMap(value.selections) || !isMap(value.tombstones)) {
    throw operationError('payload_ledger_invalid', 'payload ledger must contain object payloads, selections, and tombstones maps');
  }
  if (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || value.generation < 0)) {
    throw operationError('payload_ledger_invalid', 'payload ledger generation is invalid');
  }
  const payloads = isMap(value.payloads)
    ? Object.fromEntries(Object.entries(value.payloads).map(([id, payload]) => {
      if (!payload || typeof payload !== 'object' || payload.payload_id !== id) {
        throw operationError('payload_ledger_invalid', `payload ledger key does not match payload_id: ${id}`);
      }
      const files = normalizeLedgerFiles(payload.files);
      if (payloadIdFor(files) !== id) throw operationError('payload_ledger_invalid', `payload ${id} has an invalid identity`);
      if (typeof payload.storage_path !== 'string' || !payload.storage_path) {
        throw operationError('payload_ledger_invalid', `payload ${id} has no storage path`);
      }
      if (!insideSharedStore(payload.storage_path)) {
        throw operationError('payload_ledger_invalid', `payload ${id} storage path is outside the shared store`);
      }
      if (!['object', 'legacy'].includes(payload.layout ?? 'object')) {
        throw operationError('payload_ledger_invalid', `payload ${id} has an invalid layout`);
      }
      if (!['ready', 'deleting'].includes(payload.state ?? 'ready')) {
        throw operationError('payload_ledger_invalid', `payload ${id} has an invalid state`);
      }
      return [id, { ...payload, payload_id: id, layout: payload.layout ?? 'object', state: payload.state ?? 'ready', files }];
    }))
    : {};
  const selections = isMap(value.selections)
    ? Object.fromEntries(Object.entries(value.selections).map(([key, selection]) => {
      if (!selection || typeof selection !== 'object' || !selection.asset_id || !selection.payload_id
        || key !== selectionKey(selection.asset_id, selection.variant_id ?? 'generic')) {
        throw operationError('payload_ledger_invalid', `selection key is invalid: ${key}`);
      }
      if (!payloads[selection.payload_id]) {
        throw operationError('payload_ledger_invalid', `selection ${key} points to unknown payload: ${selection.payload_id}`);
      }
      return [key, { ...selection, variant_id: selection.variant_id ?? 'generic' }];
    }))
    : {};
  return {
    schema: PAYLOAD_LEDGER_SCHEMA,
    generation: Number.isSafeInteger(value?.generation) && value.generation >= 0 ? value.generation : 0,
    payloads,
    selections,
    tombstones: value.tombstones,
    updated_at: typeof value?.updated_at === 'string' ? value.updated_at : null,
  };
};

/** Missing v2 state is a valid empty state; malformed present state is explicit. */
export function readPayloadLedger() {
  try {
    const value = JSON.parse(fs.readFileSync(payloadLedgerPath(), 'utf8'));
    if (value?.schema !== PAYLOAD_LEDGER_SCHEMA) {
      return { ...emptyPayloadLedger(), error: `unexpected schema: ${value?.schema ?? 'missing'}` };
    }
    return normalizedLedger(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyPayloadLedger();
    return { ...emptyPayloadLedger(), error: `payload ledger unreadable: ${String(error?.message ?? error)}` };
  }
}

const requireLedger = () => {
  const ledger = readPayloadLedger();
  if (ledger.error) throw operationError('payload_ledger_corrupt', ledger.error);
  return ledger;
};

/** Atomic v2 ledger write. Callers use generation CAS before changing facts. */
export function writePayloadLedger(ledger, { expectedGeneration = undefined, project = true } = {}) {
  const current = readPayloadLedger();
  if (current.error) throw operationError('payload_ledger_corrupt', current.error);
  if (expectedGeneration !== undefined && Number(expectedGeneration) !== current.generation) {
    throw operationError('generation_mismatch', `payload ledger generation changed (${current.generation} != ${expectedGeneration})`, {
      expected_generation: Number(expectedGeneration), actual_generation: current.generation,
    });
  }
  const next = normalizedLedger(ledger);
  next.generation = current.generation + 1;
  next.updated_at = new Date().toISOString();
  const dir = path.dirname(payloadLedgerPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${payloadLedgerPath()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, payloadLedgerPath());
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync is not available on every Android filesystem */ }
  } finally { fs.rmSync(tmp, { force: true }); }
  if (project) writeSelectionProjection(next);
  return next;
}

export const SELECTION_PROJECTION_SCHEMA = 'termux-os.asset-selections.v1';
export const selectionProjectionPath = () => path.join(sharedStore(), '.objects', 'selections.v1.json');

/**
 * A read-only copy of the current Selections, placed beside the payload objects.
 *
 * ⭐ Consumers outside Termux (the Android App) cannot read the ledger in Termux private storage,
 * yet the object store keeps superseded payloads. Without this file such a consumer can only scan
 * every object, and two builds of the same target look like two valid answers. The projection
 * names exactly the selected object per asset/variant. The ledger stays authoritative: this is
 * rewritten from it when a Manager/Core operation writes the ledger, and a failure here never fails
 * the write.
 *
 * ⛔ Never written at startup, and never by the v1 migration that can run at startup. A Framework
 * update fingerprints every file under the model store (path, size, mtime) before and after the
 * swap, from the *old* controller; one write here during that window rolls the update back — on
 * every device, forever. Identical content is not rewritten either, for the same reason.
 */
export function writeSelectionProjection(ledger = readPayloadLedger()) {
  if (!ledger || ledger.error) return null;
  const selections = Object.values(ledger.selections ?? {}).map((selection) => {
    const payload = ledger.payloads?.[selection.payload_id] ?? null;
    return {
      asset_id: selection.asset_id,
      variant_id: selection.variant_id ?? 'generic',
      payload_id: selection.payload_id,
      path: payload?.storage_path ?? null,
    };
  }).filter((item) => item.asset_id && item.payload_id && item.path)
    .sort((a, b) => `${a.asset_id}\u0000${a.variant_id}`.localeCompare(`${b.asset_id}\u0000${b.variant_id}`));
  const body = { schema: SELECTION_PROJECTION_SCHEMA, generation: ledger.generation ?? 0, updated_at: ledger.updated_at ?? null, selections };
  const file = selectionProjectionPath();
  const text = `${JSON.stringify(body, null, 2)}\n`;
  try { if (fs.readFileSync(file, 'utf8') === text) return body; } catch { /* absent: write it */ }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return body;
  } catch {
    fs.rmSync(tmp, { force: true });
    return null;
  }
}

export const selectionKey = (assetId, variantId = 'generic') => `${String(assetId)}\u0000${String(variantId || 'generic')}`;

export function listPayloadRecords(ledger = requireLedger()) {
  return Object.values(ledger.payloads ?? {}).sort((a, b) => String(a.payload_id).localeCompare(String(b.payload_id)));
}

export function listSelectionRecords(ledger = requireLedger()) {
  return Object.entries(ledger.selections ?? {}).map(([key, selection]) => ({
    key, ...(selection && typeof selection === 'object' ? selection : {}),
  })).sort((a, b) => a.key.localeCompare(b.key));
}

export const payloadReferrers = (ledger, payloadId) => listSelectionRecords(ledger)
  .filter((selection) => selection.payload_id === payloadId);

const payloadRecord = ({ payloadId, files, storagePath, layout = 'object', ...extra }) => ({
  schema: 'termux-os.asset-payload.v2',
  payload_id: payloadId,
  layout,
  storage_path: storagePath ?? payloadObjectDir(payloadId),
  files: normalizeLedgerFiles(files),
  state: 'ready',
  created_at: extra.created_at ?? new Date().toISOString(),
  ...extra,
});

const validateSelection = (selection, files) => {
  const assetId = String(selection?.asset_id ?? '');
  const variantId = String(selection?.variant_id ?? 'generic');
  if (!assetId) throw operationError('asset_id_required', 'selection asset_id is required');
  const declarations = declarationsForAsset(readDeclarationIndex(), assetId)
    .filter((item) => item.variant_id === variantId);
  if (!declarations.length) {
    throw operationError('selection_declaration_missing', `no active Declaration for ${assetId}/${variantId}`);
  }
  if (declarations.length > 1) {
    throw operationError('selection_declaration_ambiguous', `multiple active Declarations for ${assetId}/${variantId}`);
  }
  const declaredFiles = new Set(Object.values(declarations[0].files ?? {}));
  const actualFiles = new Set(files.map((file) => file.path));
  const missing = [...declaredFiles].filter((file) => !actualFiles.has(file));
  if (missing.length) {
    throw operationError('selection_payload_mismatch', `Payload is missing Declaration files: ${missing.join(', ')}`, { missing });
  }
  return declarations[0];
};

/** Record several verified objects and Selections in one Ledger CAS mutation. */
export function recordPayloads(records = [], { expectedGeneration = undefined } = {}) {
  if (!Array.isArray(records) || !records.length) throw operationError('payload_records_required', 'at least one payload record is required');
  const ledger = requireLedger();
  if (expectedGeneration !== undefined && Number(expectedGeneration) !== ledger.generation) {
    throw operationError('generation_mismatch', `payload ledger generation changed (${ledger.generation} != ${expectedGeneration})`, {
      expected_generation: Number(expectedGeneration), actual_generation: ledger.generation,
    });
  }
  const prepared = records.map((record = {}) => {
    const { payloadId = null, files, storagePath = null, layout = 'object', selection = null, ...extra } = record;
    const normalizedFiles = normalizeLedgerFiles(files);
    const id = payloadId ?? payloadIdFor(normalizedFiles);
    if (id !== payloadIdFor(normalizedFiles)) throw operationError('payload_id_mismatch', 'payload_id does not match file manifest');
    const existing = ledger.payloads[id];
    // `role` describes how a caller names a verified file; it is not part of
    // the payload identity (see canonicalFileManifest/payloadIdFor).  A
    // Package install can therefore rediscover the same bytes with a
    // different role than the Manager used for its transfer.  Comparing the
    // full normalized records here made that legitimate reuse fail with a
    // false identity conflict.
    if (existing && canonicalJson(canonicalFileManifest(existing.files))
      !== canonicalJson(canonicalFileManifest(normalizedFiles))) {
      throw operationError('payload_identity_conflict', `payload ${id} already has a different file manifest`);
    }
    if (selection) validateSelection(selection, normalizedFiles);
    return { id, normalizedFiles, storagePath, layout, selection, extra, existing };
  });
  for (const item of prepared) {
    const { id, normalizedFiles, storagePath, layout, extra, existing } = item;
    ledger.payloads[id] = existing ?? payloadRecord({ payloadId: id, files: normalizedFiles, storagePath, layout, ...extra });
    /**
     * ⭐ A legacy record is upgraded when the same bytes now also exist as a verified object.
     * A legacy directory belongs to the Package that installed it and disappears with that
     * Package's uninstall; the object belongs to no one. Moving an Asset between Packages hits
     * exactly this case (same bytes, new owner), and keeping the legacy path left the selection
     * pointing at the old Package's directory while the freshly verified object was orphaned.
     */
    const upgradeToObject = existing && (existing.layout ?? 'object') === 'legacy' && layout === 'object';
    if (existing) ledger.payloads[id] = {
      ...existing, ...extra, state: 'ready',
      ...(upgradeToObject ? { layout: 'object' } : {}),
      // Keep the first ledger file metadata.  The object is immutable and its
      // role is caller metadata; replacing it on a reuse would make a
      // Manager's compatibility projection depend on install order.
      storage_path: upgradeToObject ? payloadObjectDir(id)
        : existing.storage_path ?? storagePath ?? payloadObjectDir(id),
      files: existing.files,
    };
    delete ledger.tombstones[id];
    if (item.selection) {
      const declaration = validateSelection(item.selection, normalizedFiles);
      const assetId = declaration.asset_id;
      const variantId = declaration.variant_id;
      ledger.selections[selectionKey(assetId, variantId)] = {
        asset_id: assetId,
        variant_id: variantId,
        payload_id: id,
        selected_at: new Date().toISOString(),
        ...(item.selection.source ? { source: item.selection.source } : {}),
      };
    }
  }
  const next = writePayloadLedger(ledger, { expectedGeneration: ledger.generation });
  syncCompatibilityRegistry(next);
  return {
    ledger: next,
    records: prepared.map((item) => ({
      payload: next.payloads[item.id],
      selection: item.selection ? next.selections[selectionKey(item.selection.asset_id, item.selection.variant_id ?? 'generic')] : null,
    })),
  };
}

/** Record one verified object and optionally select it in one CAS-protected write. */
export function recordPayload(record = {}) {
  const { expectedGeneration, ...payload } = record;
  const result = recordPayloads([payload], { expectedGeneration });
  return { ledger: result.ledger, payload: result.records[0].payload, selection: result.records[0].selection };
}

export function setPayloadSelection(assetId, variantId, payloadId, { expectedGeneration = undefined } = {}) {
  const ledger = requireLedger();
  if (!ledger.payloads[payloadId] || ledger.payloads[payloadId].state === 'deleting') {
    throw operationError('payload_not_found', `payload ${payloadId} is not ready`);
  }
  validateSelection({ asset_id: assetId, variant_id: variantId }, ledger.payloads[payloadId].files);
  const key = selectionKey(assetId, variantId);
  ledger.selections[key] = { asset_id: String(assetId), variant_id: String(variantId || 'generic'), payload_id: payloadId, selected_at: new Date().toISOString() };
  const next = writePayloadLedger(ledger, { expectedGeneration: expectedGeneration ?? ledger.generation });
  syncCompatibilityRegistry(next);
  return { ledger: next, selection: next.selections[key] };
}

export function clearPayloadSelection(assetId, variantId = 'generic', { expectedGeneration = undefined } = {}) {
  const ledger = requireLedger();
  if (expectedGeneration !== undefined && Number(expectedGeneration) !== ledger.generation) {
    throw operationError('generation_mismatch', `payload ledger generation changed (${ledger.generation} != ${expectedGeneration})`, {
      expected_generation: Number(expectedGeneration), actual_generation: ledger.generation,
    });
  }
  const key = selectionKey(assetId, variantId);
  const previous = ledger.selections[key] ?? null;
  if (!previous) return { ledger, selection: null, changed: false };
  delete ledger.selections[key];
  const next = writePayloadLedger(ledger, { expectedGeneration: expectedGeneration ?? ledger.generation });
  syncCompatibilityRegistry(next);
  return { ledger: next, selection: previous, changed: true };
}

/** Restore a package operation's Selection slice without touching other assets. */
export function restorePayloadSelections(entries = [], { expectedGeneration = undefined } = {}) {
  if (!Array.isArray(entries)) throw operationError('selection_snapshot_invalid', 'selection snapshot must be an array');
  const ledger = requireLedger();
  if (expectedGeneration !== undefined && Number(expectedGeneration) !== ledger.generation) {
    throw operationError('generation_mismatch', `payload ledger generation changed (${ledger.generation} != ${expectedGeneration})`, {
      expected_generation: Number(expectedGeneration), actual_generation: ledger.generation,
    });
  }
  const next = { ...ledger, selections: { ...ledger.selections } };
  let changed = false;
  for (const entry of entries) {
    const assetId = String(entry?.asset_id ?? '');
    const variantId = String(entry?.variant_id ?? 'generic');
    if (!assetId) throw operationError('asset_id_required', 'selection snapshot asset_id is required');
    const key = selectionKey(assetId, variantId);
    const previous = next.selections[key] ?? null;
    const selection = entry?.selection ?? null;
    if (!selection) {
      if (previous) { delete next.selections[key]; changed = true; }
      continue;
    }
    const payloadId = String(selection.payload_id ?? '');
    const payload = next.payloads[payloadId];
    if (!payload || payload.state === 'deleting') throw operationError('payload_not_found', `selection snapshot payload ${payloadId} is not ready`);
    validateSelection({ asset_id: assetId, variant_id: variantId }, payload.files);
    const restored = {
      ...selection, asset_id: assetId, variant_id: variantId, payload_id: payloadId,
    };
    if (canonicalJson(previous) !== canonicalJson(restored)) { next.selections[key] = restored; changed = true; }
  }
  if (!changed) return { ledger, changed: false };
  const written = writePayloadLedger(next, { expectedGeneration: ledger.generation });
  syncCompatibilityRegistry(written);
  return { ledger: written, changed: true };
}

/** Short-lived v1 read compatibility; v2 remains authoritative. */
export function compatibilityRegistryFromPayloadLedger(ledger = requireLedger()) {
  const assets = {};
  for (const selection of listSelectionRecords(ledger)) {
    const payload = ledger.payloads?.[selection.payload_id];
    if (!payload || payload.state === 'deleting') continue;
    const files = Object.fromEntries(payload.files.map((file) => [file.role ?? file.path, file.path]));
    const checksums = Object.fromEntries(payload.files.map((file) => [file.path, file.sha256]));
    assets[selection.asset_id] = {
      kind: 'asset',
      package_id: payload.package_id ?? null,
      version: payload.version ?? null,
      target: selection.variant_id,
      target_spec: payload.target ?? null,
      path: payload.storage_path,
      files,
      checksums,
      // v1 consumers used this field as a quick file digest.  The v2 object
      // identity is the manifest digest, so retain the first file digest here
      // and expose the actual object id separately.
      sha256: payload.files?.[0]?.sha256 ?? null,
      payload_id: payload.payload_id,
      v2: true,
    };
  }
  return { schema: REGISTRY_SCHEMA, assets };
}

/** Keep old read-only callers coherent while the v2 ledger is authoritative. */
export function syncCompatibilityRegistry(ledger = requireLedger()) {
  if (ledger.error) throw operationError('payload_ledger_corrupt', ledger.error);
  const projection = compatibilityRegistryFromPayloadLedger(ledger);
  writeRegistry(projection);
  return projection;
}

export function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024); // 479MB 的 ctx 不能一次讀進記憶體
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export function readRegistry() {
  try {
    const r = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    if (r?.schema !== REGISTRY_SCHEMA) return { schema: REGISTRY_SCHEMA, assets: {}, error: `unexpected schema: ${r?.schema}` };
    return { schema: REGISTRY_SCHEMA, assets: r.assets ?? {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schema: REGISTRY_SCHEMA, assets: {} }; // 尚未安裝任何 asset = 空登記，不是錯誤
    return { schema: REGISTRY_SCHEMA, assets: {}, error: `registry unreadable: ${String(error?.message ?? error)}` };
  }
}

/** 原子寫（tmp+rename）：登記檔壞掉會讓所有 asset 一起失蹤，值得這一次 rename */
export function writeRegistry(reg) {
  const dir = registryDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${REGISTRY_FILENAME}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: REGISTRY_SCHEMA, assets: reg.assets ?? {} }, null, 2)}\n`);
  fs.renameSync(tmp, registryPath());
}

/** 登記一個 asset 為 active（Installer 用）。previous 保留以便 rollback 只切指針（§6.2） */
export function activateAsset(assetId, entry) {
  const reg = readRegistry();
  if (reg.error) throw operationError('registry_corrupt', reg.error);
  const prev = reg.assets[assetId];
  reg.assets[assetId] = {
    ...entry,
    previous: prev ? { version: prev.version, target: prev.target, path: prev.path, sha256: prev.sha256 } : null,
    activated_at: new Date().toISOString(),
  };
  writeRegistry(reg);
  return reg.assets[assetId];
}

/** 卸載只摘 active 登記；**payload 一律保留**（§6.3 無 purge） */
export function deactivateAsset(assetId) {
  const reg = readRegistry();
  if (reg.error) throw operationError('registry_corrupt', reg.error);
  if (!reg.assets[assetId]) return false;
  delete reg.assets[assetId];
  writeRegistry(reg);
  return true;
}

// ============================================================
// 自檢：node src/assets/registry.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assetreg-'));
  process.env.ASSETS_REGISTRY_DIR = path.join(tmp, 'reg');
  process.env.SHARED_ASSET_STORE = path.join(tmp, 'store');

  t('missing registry = empty, not error', readRegistry().assets && Object.keys(readRegistry().assets).length === 0);

  const e1 = activateAsset('model.x', { package_id: 'p', version: '0.1.0', target: 'tgt', path: '/a', sha256: 'aa' });
  t('activate writes entry', readRegistry().assets['model.x'].version === '0.1.0' && e1.previous === null);

  activateAsset('model.x', { package_id: 'p', version: '0.1.1', target: 'tgt', path: '/b', sha256: 'bb' });
  const r2 = readRegistry().assets['model.x'];
  t('previous kept for rollback', r2.version === '0.1.1' && r2.previous.version === '0.1.0' && r2.previous.path === '/a');

  t('deactivate removes entry', deactivateAsset('model.x') && !readRegistry().assets['model.x']);
  t('deactivate unknown = false', deactivateAsset('model.ghost') === false);

  fs.writeFileSync(registryPath(), '{"schema":"wrong.v9","assets":{"a":1}}');
  t('bad schema surfaces error, not silent trust', !!readRegistry().error);
  fs.writeFileSync(registryPath(), 'not json at all');
  t('corrupt registry surfaces an explicit error', Object.keys(readRegistry().assets).length === 0 && !!readRegistry().error);

  const f = path.join(tmp, 'f.bin');
  fs.writeFileSync(f, 'hello');
  t('sha256File matches known digest',
    sha256File(f) === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  t('assetVersionDir is immutable-versioned',
    assetVersionDir('pkg', '0.1.0', 'tgt') === path.join(tmp, 'store/pkg/0.1.0/tgt'));

  const roleNeutral = { path: 'f.bin', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' };
  const roleFirst = recordPayload({ files: [{ ...roleNeutral, role: 'generic' }] });
  const roleReuse = recordPayload({ files: [{ ...roleNeutral, role: 'htp_source' }] });
  t('role metadata does not create a false payload identity conflict',
    roleFirst.payload.payload_id === roleReuse.payload.payload_id
      && roleReuse.payload.files[0].role === 'generic');

  {
    // A legacy record whose bytes are now committed as an object becomes that object.
    {
      const files = [{ path: 'h.bin', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }];
      const legacy = recordPayload({ files, layout: 'legacy', storagePath: path.join(tmp, 'store/old.pkg/1.0.0/t/p') });
      t('a legacy record starts at its package directory', legacy.payload.layout === 'legacy');
      const upgraded = recordPayload({ files, layout: 'object' });
      t('an object commit of the same bytes moves the record into the object store',
        upgraded.payload.layout === 'object' && upgraded.payload.storage_path === payloadObjectDir(upgraded.payload.payload_id));
    }
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    writeSelectionProjection({
      generation: 7, updated_at: 'now',
      payloads: { [idA]: { payload_id: idA, storage_path: payloadObjectDir(idA) }, [idB]: { payload_id: idB, storage_path: payloadObjectDir(idB) } },
      selections: { [selectionKey('model.ctx', 'android-arm64-v79-qnn249')]: { asset_id: 'model.ctx', variant_id: 'android-arm64-v79-qnn249', payload_id: idB } },
    });
    const projected = JSON.parse(fs.readFileSync(selectionProjectionPath(), 'utf8'));
    const entry = projected.selections.find((item) => item.asset_id === 'model.ctx');
    t('a ledger write projects the selected object beside the objects, for consumers outside Termux',
      projected.schema === SELECTION_PROJECTION_SCHEMA && projected.generation === 7
        && entry?.variant_id === 'android-arm64-v79-qnn249' && entry?.payload_id === idB
        && entry?.path === payloadObjectDir(idB));
    t('an unselected payload object is not projected',
      !projected.selections.some((item) => item.payload_id === idA));
    const before = fs.statSync(selectionProjectionPath()).mtimeMs;
    const again = fs.readFileSync(selectionProjectionPath(), 'utf8');
    const sameLedger = JSON.parse(again);
    writeSelectionProjection({
      generation: sameLedger.generation, updated_at: sameLedger.updated_at,
      payloads: { [idB]: { payload_id: idB, storage_path: payloadObjectDir(idB) } },
      selections: { [selectionKey('model.ctx', 'android-arm64-v79-qnn249')]: { asset_id: 'model.ctx', variant_id: 'android-arm64-v79-qnn249', payload_id: idB } },
    });
    t('identical content is not rewritten, so an update boundary fingerprint cannot move',
      fs.statSync(selectionProjectionPath()).mtimeMs === before);
    writePayloadLedger({ ...readPayloadLedger(), selections: {} });
    t('every ledger write refreshes the projection',
      JSON.parse(fs.readFileSync(selectionProjectionPath(), 'utf8')).selections.length === 0);
  }

  fs.mkdirSync(path.dirname(payloadLedgerPath()), { recursive: true });
  fs.writeFileSync(payloadLedgerPath(), `{"schema":"${PAYLOAD_LEDGER_SCHEMA}"}`);
  t('v2 ledger with missing state maps is corrupt, not empty', readPayloadLedger().error?.includes('payload ledger must contain') === true);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
