/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The legacy v1 Asset registry, active Package declarations, and existing payload paths.
 * [OUTPUT]: A no-byte-move v2 Payload Ledger migration with explicit orphan/missing reports.
 * [POS]: src/assets/migration.mjs in termux-os-framework.
 * [PROTOCOL]: Migration never deletes or moves model bytes and never creates declarations.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_FILENAME, PAYLOAD_LEDGER_SCHEMA, emptyPayloadLedger, payloadIdFor, payloadLedgerPath,
  readPayloadLedger, readRegistry, registryDir, registryPath, syncCompatibilityRegistry,
  compatibilityRegistryFromPayloadLedger, canonicalJson,
  writePayloadLedger, selectionKey, sharedStore,
} from './registry.mjs';
import { readDeclarationIndex, declarationsForAsset } from './declarations.mjs';
import { sha256File } from './registry.mjs';

export const MIGRATION_SCHEMA = 'termux-os.asset-payload-migration.v2';
export const migrationPath = () => process.env.ASSET_PAYLOAD_MIGRATION_PATH
  || path.join(registryDir(), 'migration.v2.json');

const writeMarker = (marker) => {
  const target = migrationPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
    try {
      const dir = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { /* directory fsync is not available on every Android filesystem */ }
  }
  finally { fs.rmSync(tmp, { force: true }); }
};

const readMarker = () => {
  try { return JSON.parse(fs.readFileSync(migrationPath(), 'utf8')); } catch { return null; }
};

const safeRelative = (value) => typeof value === 'string' && value.length > 0
  && !path.posix.isAbsolute(value) && !value.includes('\\')
  && path.posix.normalize(value) === value && value !== '.' && !value.split('/').includes('..');

const pathInsideStore = (value) => {
  if (typeof value !== 'string' || !value) return false;
  const root = path.resolve(sharedStore());
  const target = path.resolve(value);
  return target !== root && target.startsWith(`${root}${path.sep}`);
};

// v1 contains timestamps and rollback-only fields that are not part of the
// authoritative fact projection. Compare only the fields a v2 projection can
// reproduce; this detects a legacy Core mutation without treating formatting
// or an old `previous` record as a mutation.
const projectionAsset = (entry) => ({
  kind: entry?.kind ?? 'asset',
  package_id: entry?.package_id ?? null,
  version: entry?.version ?? null,
  target: entry?.target ?? null,
  target_spec: entry?.target_spec ?? null,
  path: entry?.path ?? null,
  files: entry?.files ?? {},
  checksums: entry?.checksums ?? {},
  sha256: entry?.sha256 ?? null,
  payload_id: entry?.payload_id ?? null,
  v2: entry?.v2 === true,
});

const projectionAssets = (assets) => Object.fromEntries(Object.entries(assets ?? {})
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, entry]) => [id, projectionAsset(entry)]));

const projectionFingerprint = (assets) => crypto.createHash('sha256')
  .update(canonicalJson(projectionAssets(assets))).digest('hex');

const projectionMatches = (legacy, ledger) => canonicalJson(projectionAssets(legacy?.assets))
  === canonicalJson(projectionAssets(compatibilityRegistryFromPayloadLedger(ledger)?.assets));

const existingFiles = (entry, { requireEvidence = false } = {}) => {
  if (!entry?.path) return { ok: false, error: 'legacy_payload_missing' };
  if (!pathInsideStore(entry.path)) return { ok: false, error: 'legacy_payload_outside_store' };
  if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) return { ok: false, error: 'legacy_payload_missing' };
  let realRoot;
  try { realRoot = fs.realpathSync(entry.path); } catch { return { ok: false, error: 'legacy_payload_missing' }; }
  if (!pathInsideStore(realRoot)) return { ok: false, error: 'legacy_payload_outside_store' };
  const checksums = entry.checksums && typeof entry.checksums === 'object' && !Array.isArray(entry.checksums)
    ? entry.checksums : null;
  if (requireEvidence && (!checksums || !Object.keys(checksums).length)) {
    return { ok: false, error: 'legacy_previous_unverified' };
  }
  const byPath = new Map();
  for (const [role, relative] of Object.entries(entry.files ?? {})) {
    if (!safeRelative(relative)) {
      return { ok: false, error: 'legacy_payload_path_invalid', role, path: relative };
    }
    const target = path.join(entry.path, relative);
    if (!pathInsideStore(target) || !target.startsWith(`${path.resolve(entry.path)}${path.sep}`)) {
      return { ok: false, error: 'legacy_payload_path_invalid', role, path: relative };
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, error: 'legacy_payload_missing_file', role, path: relative };
    let realFile;
    try { realFile = fs.realpathSync(target); } catch { return { ok: false, error: 'legacy_payload_missing_file', role, path: relative }; }
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) return { ok: false, error: 'legacy_payload_outside_store', role, path: relative };
    const size = fs.statSync(target).size;
    const sha256 = sha256File(target);
    if (checksums?.[relative] !== undefined && String(checksums[relative]).toLowerCase() !== sha256) {
      return { ok: false, error: 'legacy_payload_checksum_mismatch', role, path: relative };
    }
    if (requireEvidence && typeof checksums?.[relative] !== 'string') {
      return { ok: false, error: 'legacy_previous_unverified', role, path: relative };
    }
    const previous = byPath.get(relative);
    if (previous && (previous.size !== size || previous.sha256 !== sha256)) return { ok: false, error: 'legacy_payload_conflicting_file', path: relative };
    byPath.set(relative, { path: relative, size, sha256, role });
  }
  // A v1 entry with no role map cannot prove what was stored; report it rather
  // than inventing a file manifest from arbitrary directory contents.
  if (!byPath.size) return { ok: false, error: 'legacy_payload_file_manifest_missing' };
  return { ok: true, files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
};

const declarationFor = (index, assetId, target) => declarationsForAsset(index, assetId)
  .find((item) => item.variant_id === (target || 'generic'))
  ?? (declarationsForAsset(index, assetId).length === 1 ? declarationsForAsset(index, assetId)[0] : null);

/**
 * Migrate once at Framework startup, after Packages have been scanned. The
 * returned report is safe to show in diagnostics and contains no model bytes.
 */
export function migrateV1ToV2({ index = null } = {}) {
  const marker = readMarker();
  const current = readPayloadLedger();
  if (current.error) return { schema: MIGRATION_SCHEMA, completed: false, error: 'payload_ledger_corrupt', detail: current.error };
  const legacyExists = fs.existsSync(registryPath());
  const legacy = readRegistry();
  if (legacy.error) return { schema: MIGRATION_SCHEMA, completed: false, error: 'legacy_registry_invalid', detail: legacy.error };
  const legacyProjectionMismatch = marker?.schema === MIGRATION_SCHEMA && marker.completed === true
    && legacyExists && !projectionMatches(legacy, current);
  if (marker?.schema === MIGRATION_SCHEMA && marker.completed === true && !legacyProjectionMismatch) return marker;
  const declarations = index ?? readDeclarationIndex();
  const next = { ...emptyPayloadLedger(), ...current, payloads: { ...current.payloads }, selections: { ...current.selections }, tombstones: { ...current.tombstones } };
  const report = {
    schema: MIGRATION_SCHEMA,
    completed: true,
    started_at: new Date().toISOString(),
    legacy_registry: legacyExists ? registryPath() : null,
    backup: null,
    migrated: [],
    previous_migrated: [],
    legacy_previous_unverified: [],
    missing: [],
    orphaned: [],
    conflicts: [],
    legacy_projection_mismatch: legacyProjectionMismatch,
    legacy_selection_cleared: [],
    legacy_selection_replaced: [],
    projection_fingerprint: null,
  };
  if (legacyExists) {
    const backup = `${registryPath()}.v2-backup`;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(registryPath(), backup);
      try { fs.chmodSync(backup, 0o600); } catch { /* permissions are best effort on FUSE */ }
    }
    report.backup = backup;
  }
  const byRealPath = new Map();
  let changed = legacyExists && !fs.existsSync(payloadLedgerPath());
  if (legacyProjectionMismatch) {
    // v1 projections contain only selected ready entries. If an older Core
    // removed one while v2 was authoritative, retain its Payload Object but
    // import the missing Selection as an explicit detach.
    const legacyAssetIds = new Set(Object.keys(legacy.assets ?? {}));
    for (const [key, selection] of Object.entries(next.selections)) {
      if (legacyAssetIds.has(selection.asset_id)) continue;
      delete next.selections[key];
      report.legacy_selection_cleared.push({ key, asset_id: selection.asset_id, variant_id: selection.variant_id });
      changed = true;
    }
  }
  const clearSelectionFor = (assetId, target) => {
    if (!legacyProjectionMismatch) return;
    const declaration = declarationFor(declarations, assetId, target);
    if (!declaration) return;
    const key = selectionKey(assetId, declaration.variant_id);
    if (!next.selections[key]) return;
    delete next.selections[key];
    report.legacy_selection_cleared.push({ key, asset_id: assetId, variant_id: declaration.variant_id, reason: 'legacy_entry_unverifiable' });
    changed = true;
  };
  const registerEntry = (assetId, entry, { selected = false, isPrevious = false } = {}) => {
    const files = existingFiles(entry, { requireEvidence: isPrevious });
    if (!files.ok) {
      if (isPrevious && files.error === 'legacy_previous_unverified') report.legacy_previous_unverified.push({ asset_id: assetId, path: entry?.path ?? null, ...files });
      else if (isPrevious) report.legacy_previous_unverified.push({ asset_id: assetId, path: entry?.path ?? null, reason: files.error, ...files });
      else report.missing.push({ asset_id: assetId, ...files });
      if (selected) clearSelectionFor(assetId, entry?.target);
      return;
    }
    let realPath;
    try { realPath = fs.realpathSync(entry.path); } catch { realPath = path.resolve(entry.path); }
    if (!pathInsideStore(realPath)) {
      const outside = { asset_id: assetId, path: realPath, error: 'legacy_payload_outside_store' };
      if (isPrevious) report.legacy_previous_unverified.push(outside);
      else report.missing.push(outside);
      return;
    }
    const payloadId = payloadIdFor(files.files);
    const prior = byRealPath.get(realPath);
    if (prior && prior.payload_id !== payloadId) {
      report.conflicts.push({ asset_id: assetId, path: realPath, previous_payload_id: prior.payload_id, payload_id: payloadId, previous_entry: prior.entry_kind, entry_kind: isPrevious ? 'legacy_previous' : 'legacy_current' });
      return;
    }
    if (!prior) byRealPath.set(realPath, { payload_id: payloadId, files: files.files, entry_kind: isPrevious ? 'legacy_previous' : 'legacy_current' });
    if (!next.payloads[payloadId]) {
      next.payloads[payloadId] = {
        schema: 'termux-os.asset-payload.v2',
        payload_id: payloadId,
        layout: 'legacy',
        storage_path: realPath,
        files: files.files,
        state: 'ready',
        package_id: entry.package_id ?? null,
        version: entry.version ?? null,
        target: entry.target_spec ?? null,
        provenance: 'v1_migration',
        created_at: new Date().toISOString(),
      };
      changed = true;
    }
    if (!selected) {
      report.previous_migrated.push({ asset_id: assetId, payload_id: payloadId, path: entry.path, selected: false });
      return;
    }
    const declaration = declarationFor(declarations, assetId, entry.target);
    if (declaration) {
      const key = selectionKey(assetId, declaration.variant_id);
      if (next.selections[key] && next.selections[key].payload_id !== payloadId) {
        if (legacyProjectionMismatch) {
          report.legacy_selection_replaced.push({ asset_id: assetId, variant_id: declaration.variant_id,
            previous_payload_id: next.selections[key].payload_id, payload_id: payloadId });
          next.selections[key] = { asset_id: assetId, variant_id: declaration.variant_id, payload_id: payloadId,
            selected_at: new Date().toISOString(), provenance: 'legacy_mutation_import' };
          changed = true;
        } else {
          report.conflicts.push({ asset_id: assetId, variant_id: declaration.variant_id, existing_payload_id: next.selections[key].payload_id, payload_id: payloadId });
        }
      } else {
        if (!next.selections[key]) {
          next.selections[key] = { asset_id: assetId, variant_id: declaration.variant_id, payload_id: payloadId, selected_at: new Date().toISOString(), provenance: 'v1_migration' };
          changed = true;
        }
      }
      report.migrated.push({ asset_id: assetId, payload_id: payloadId, path: entry.path, selected: true });
    } else {
      report.orphaned.push({ asset_id: assetId, payload_id: payloadId, path: entry.path });
    }
  };
  for (const [assetId, entry] of Object.entries(legacy.assets ?? {})) {
    registerEntry(assetId, entry, { selected: true });
    if (entry?.previous) registerEntry(assetId, entry.previous, { isPrevious: true });
  }
  const written = changed
    ? writePayloadLedger(next, { expectedGeneration: current.generation })
    : current;
  if (legacyExists || changed) syncCompatibilityRegistry(written);
  report.generation = written.generation;
  report.projection_fingerprint = projectionFingerprint(compatibilityRegistryFromPayloadLedger(written).assets);
  report.finished_at = new Date().toISOString();
  writeMarker(report);
  return report;
}

// ============================================================
// Self-test: node src/assets/migration.mjs --self-test
// ============================================================
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-migration-'));
  process.env.ASSETS_REGISTRY_DIR = path.join(root, 'registry');
  process.env.ASSET_PAYLOAD_LEDGER_PATH = path.join(root, 'registry', 'payloads.v2.json');
  process.env.ASSET_PAYLOAD_MIGRATION_PATH = path.join(root, 'registry', 'migration.v2.json');
  process.env.SHARED_ASSET_STORE = path.join(root, 'models');
  const payload = path.join(root, 'models', 'legacy');
  const previousPayload = path.join(root, 'models', 'legacy-previous');
  fs.mkdirSync(payload, { recursive: true });
  fs.mkdirSync(previousPayload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'model.bin'), 'legacy bytes');
  fs.writeFileSync(path.join(previousPayload, 'model.bin'), 'previous legacy bytes');
  const hash = sha256File(path.join(payload, 'model.bin'));
  const previousHash = sha256File(path.join(previousPayload, 'model.bin'));
  fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  fs.writeFileSync(registryPath(), `${JSON.stringify({
    schema: 'termux-os.asset-registry.v1',
    assets: { 'model.legacy': { package_id: 'pkg.asset', version: '1.0.0', target: 'generic', path: payload, files: { model: 'model.bin' }, checksums: { 'model.bin': hash }, previous: {
      package_id: 'pkg.asset', version: '0.9.0', target: 'generic', path: previousPayload,
      files: { model: 'model.bin' }, checksums: { 'model.bin': previousHash },
    } } },
  })}\n`);
  const versionRoot = path.join(root, 'pkg', 'versions', '1.0.0');
  fs.mkdirSync(versionRoot, { recursive: true });
  fs.writeFileSync(path.join(versionRoot, 'termux-os.package.json'), `${JSON.stringify({ id: 'pkg.asset', version: '1.0.0', assets: { provides: [{ id: 'model.legacy', kind: 'model', payload: 'legacy', files: { model: 'model.bin' } }] } })}\n`);
  const report = migrateV1ToV2({ index: readDeclarationIndex({ packageEntries: [{ id: 'pkg.asset', versionRoot, active: { active_version: '1.0.0' } }] }) });
  test('v1 payload migrates without moving bytes', report.migrated.length === 1 && fs.existsSync(path.join(payload, 'model.bin')));
  test('migration creates a selection only for an active declaration', Object.keys(readPayloadLedger().selections).length === 1);
  test('verified v1 previous is retained as an unselected legacy Payload', report.previous_migrated.length === 1
    && Object.keys(readPayloadLedger().payloads).length === 2
    && fs.existsSync(path.join(previousPayload, 'model.bin')));
  test('migration leaves a backup and idempotent marker', fs.existsSync(`${registryPath()}.v2-backup`) && migrateV1ToV2().generation === report.generation);

  const replacementPayload = path.join(root, 'models', 'legacy-replacement');
  fs.mkdirSync(replacementPayload, { recursive: true });
  fs.writeFileSync(path.join(replacementPayload, 'model.bin'), 'legacy replacement');
  const replacementHash = sha256File(path.join(replacementPayload, 'model.bin'));
  const { activateAsset } = await import('./registry.mjs');
  activateAsset('model.legacy', {
    package_id: 'pkg.asset', version: '0.8.0', target: 'generic', path: replacementPayload,
    files: { model: 'model.bin' }, checksums: { 'model.bin': replacementHash }, sha256: replacementHash,
  });
  const mutation = migrateV1ToV2({ index: readDeclarationIndex({ packageEntries: [{ id: 'pkg.asset', versionRoot, active: { active_version: '1.0.0' } }] }) });
  const afterMutation = readPayloadLedger();
  test('legacy projection mutation is imported explicitly, not silently overwritten', mutation.legacy_projection_mismatch === true
    && mutation.legacy_selection_replaced.length === 1 && Object.keys(afterMutation.payloads).length === 3
    && afterMutation.selections['model.legacy\u0000generic']?.payload_id === mutation.legacy_selection_replaced[0].payload_id);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
