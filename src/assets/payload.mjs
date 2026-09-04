/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A registered Asset id and explicit registry/path expectations.
 * [OUTPUT]: Safe generic removal of one verified raw Asset payload and its registry entry.
 * [POS]: src/assets/payload.mjs in termux-os-framework.
 * [PROTOCOL]: Only paths owned by the Asset Registry inside the shared Asset Store may be purged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deactivateAsset, readRegistry, sharedStore, sha256File } from './registry.mjs';

const under = (root, candidate) => {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target !== base && target.startsWith(`${base}${path.sep}`);
};

const mismatch = (field, expected, actual) => expected !== undefined
  && expected !== null && String(expected) !== String(actual ?? '')
  ? { ok: false, error: `expectation_mismatch:${field}`, expected, actual: actual ?? null } : null;

const registeredPathOwners = (assets, target, ignoredId) => Object.entries(assets ?? {})
  .filter(([id, entry]) => id !== ignoredId && typeof entry?.path === 'string'
    && path.resolve(entry.path) === target)
  .map(([id]) => id);

const verifyEntryFiles = (entry) => {
  const checksums = entry?.checksums && typeof entry.checksums === 'object' ? entry.checksums : {};
  if (!entry?.path || !fs.existsSync(entry.path)) return { ok: true, checked: 0, missing: true };
  let checked = 0;
  for (const [relative, expected] of Object.entries(checksums)) {
    if (typeof expected !== 'string' || !expected) continue;
    const candidate = path.resolve(entry.path, relative);
    if (!under(entry.path, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      return { ok: false, error: 'payload_file_missing', path: relative };
    }
    if (sha256File(candidate) !== expected.toLowerCase()) {
      return { ok: false, error: 'payload_checksum_mismatch', path: relative };
    }
    checked++;
  }
  return { ok: true, checked, missing: false };
};

/**
 * Remove a payload only after the caller confirms the registry identity.
 * The operation is deliberately independent of package/model semantics: an
 * Asset may be a model, a language pack, or another raw package payload.
 */
export function purgeAssetPayload(assetId, { expected = {} } = {}) {
  if (typeof assetId !== 'string' || !assetId) return { ok: false, error: 'asset_id_required' };
  const registry = readRegistry();
  const entry = registry.assets?.[assetId];
  if (!entry) return { ok: false, error: 'unknown_asset', asset_id: assetId };
  for (const field of ['package_id', 'version', 'target']) {
    const check = mismatch(field, expected?.[field], entry[field]);
    if (check) return { ...check, asset_id: assetId };
  }
  if (expected?.path !== undefined) {
    const actualPath = typeof entry.path === 'string' ? path.resolve(entry.path) : null;
    const check = mismatch('path', path.resolve(String(expected.path)), actualPath);
    if (check) return { ...check, asset_id: assetId };
  }
  const store = sharedStore();
  if (typeof entry.path !== 'string' || !under(store, entry.path)) {
    return { ok: false, error: 'payload_outside_shared_store', asset_id: assetId, path: entry.path ?? null };
  }
  const target = path.resolve(entry.path);
  const owners = registeredPathOwners(registry.assets, target, assetId);
  if (owners.length) {
    return { ok: false, error: 'payload_shared', asset_id: assetId, owners };
  }
  const verified = verifyEntryFiles(entry);
  if (!verified.ok) return { ...verified, asset_id: assetId };

  // Detach the registry first, so a successful byte deletion can never leave
  // an apparently ready path. If deletion fails, the response exposes that
  // the registry is already detached and the remaining bytes can be retried.
  const registryDeactivated = deactivateAsset(assetId);
  let removed = false;
  try {
    removed = fs.existsSync(target);
    if (removed) fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return {
      ok: false,
      error: 'payload_delete_failed',
      asset_id: assetId,
      registry_deactivated: registryDeactivated,
      path: target,
      detail: String(error?.message ?? error),
    };
  }
  return {
    ok: true,
    asset_id: assetId,
    path: target,
    removed,
    registry_deactivated: registryDeactivated,
    checked_files: verified.checked,
  };
}

// ============================================================
// Self-test: node src/assets/payload.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-payload-'));
  process.env.ASSETS_REGISTRY_DIR = path.join(root, 'registry');
  process.env.SHARED_ASSET_STORE = path.join(root, 'models');
  const payload = path.join(process.env.SHARED_ASSET_STORE, 'pkg', '1.0.0', 'generic', 'raw');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'model.bin'), 'raw');
  const digest = sha256File(path.join(payload, 'model.bin'));
  const { activateAsset, readRegistry: read } = await import('./registry.mjs');
  activateAsset('asset.raw', {
    package_id: 'pkg', version: '1.0.0', target: 'generic', path: payload,
    checksums: { 'model.bin': digest },
  });
  const wrong = purgeAssetPayload('asset.raw', { expected: { version: '9.0.0' } });
  test('identity expectation prevents wrong deletion', wrong.error === 'expectation_mismatch:version');
  const done = purgeAssetPayload('asset.raw', { expected: { package_id: 'pkg', version: '1.0.0', target: 'generic' } });
  test('generic payload purge removes bytes and registry entry', done.ok && !fs.existsSync(payload)
    && !read().assets['asset.raw']);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
