/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A tar.gz raw Asset archive carrying `termux-os.asset-archive.json` and declared files.
 * [OUTPUT]: Verified raw payloads registered in the generic Asset Registry.
 * [POS]: src/assets/archive.mjs in termux-os-framework.
 * [PROTOCOL]: Archive extraction is path-safe, hash/size checked, and never handles runtime artifacts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activateAsset, readRegistry, sharedStore, sha256File } from './registry.mjs';

export const ASSET_ARCHIVE_SCHEMA = 'termux-os.asset-archive.v1';
export const ASSET_ARCHIVE_MANIFEST = 'termux-os.asset-archive.json';

const safeComponent = (value) => typeof value === 'string'
  && value.length > 0 && value !== '.' && value !== '..'
  && !value.includes('/') && !value.includes('\\')
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

const safeRelative = (value) => typeof value === 'string' && value.length > 0
  && !path.posix.isAbsolute(value) && !value.includes('\\')
  && path.posix.normalize(value) === value && value !== '.' && !value.split('/').includes('..');

const within = (root, candidate) => {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
};

const normalizeTarEntry = (entry) => entry.replace(/^\.\//, '').replace(/\/$/, '');

function listArchiveEntries(archivePath) {
  let output;
  try {
    output = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`invalid_asset_archive:${String(error?.message ?? error)}`);
  }
  const entries = output.split(/\r?\n/).map(normalizeTarEntry).filter(Boolean);
  if (entries.some((entry) => !safeRelative(entry))) throw new Error('asset_archive_path_traversal');
  if (new Set(entries).size !== entries.length) throw new Error('asset_archive_duplicate_entry');
  return entries;
}

function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`asset_archive_symlink:${path.relative(root, absolute)}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
      else throw new Error(`asset_archive_special_file:${path.relative(root, absolute)}`);
    }
  };
  walk(root);
  return files.sort();
}

function normalizeAssets(metadata) {
  if (!metadata || metadata.schema !== ASSET_ARCHIVE_SCHEMA) throw new Error('asset_archive_schema_mismatch');
  if (!safeComponent(metadata.package_id) || !safeComponent(metadata.version)
    || !safeComponent(metadata.target ?? 'generic')) throw new Error('asset_archive_identity_invalid');
  const rawAssets = Array.isArray(metadata.assets)
    ? metadata.assets
    : (metadata.asset ? [metadata.asset] : []);
  if (!rawAssets.length) throw new Error('asset_archive_assets_missing');
  const ids = new Set();
  return rawAssets.map((asset) => {
    if (!safeComponent(asset?.id) || ids.has(asset.id)) throw new Error('asset_archive_asset_id_invalid');
    ids.add(asset.id);
    const payload = asset.payload ?? asset.id;
    if (!safeRelative(payload)) throw new Error(`asset_archive_payload_invalid:${asset.id}`);
    if (!Array.isArray(asset.files) || !asset.files.length) throw new Error(`asset_archive_files_missing:${asset.id}`);
    const filePaths = new Set();
    const files = asset.files.map((file) => {
      // The manifest path is relative to this asset's payload directory.
      if (!safeRelative(file?.path)) throw new Error(`asset_archive_file_path_invalid:${asset.id}`);
      if (filePaths.has(file.path) || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0
        || !/^[0-9a-f]{64}$/i.test(String(file.sha256 ?? ''))) {
        throw new Error(`asset_archive_file_metadata_invalid:${asset.id}`);
      }
      filePaths.add(file.path);
      return {
        path: file.path,
        size: Number(file.size),
        sha256: String(file.sha256).toLowerCase(),
        role: typeof file.role === 'string' && file.role ? file.role : file.path,
      };
    });
    return {
      id: asset.id,
      payload,
      files,
      source: asset.source ?? metadata.source ?? null,
      target: asset.target ?? metadata.target ?? 'generic',
    };
  });
}

const archiveFilePath = (stage, asset, file) => path.join(stage, 'payload', asset.payload, ...file.path.split('/'));

function expectedArchiveFiles(assets) {
  const expected = new Set([ASSET_ARCHIVE_MANIFEST]);
  for (const asset of assets) {
    expected.add('payload');
    expected.add(`payload/${asset.payload}`);
    for (const file of asset.files) expected.add(`payload/${asset.payload}/${file.path}`);
  }
  // Tar archives normally include directory entries. The extraction check
  // below only compares files; this set remains the authoritative file list.
  return expected;
}

function existingPayloadMatches(finalRoot, asset) {
  if (!fs.existsSync(finalRoot)) return { exists: false, ok: true };
  if (!fs.statSync(finalRoot).isDirectory()) return { exists: true, ok: false, error: 'asset_archive_payload_conflict' };
  for (const file of asset.files) {
    const target = path.join(finalRoot, ...file.path.split('/'));
    if (!within(finalRoot, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { exists: true, ok: false, error: 'asset_archive_payload_conflict', path: file.path };
    }
    const st = fs.statSync(target);
    if (st.size !== file.size || sha256File(target) !== file.sha256) {
      return { exists: true, ok: false, error: 'asset_archive_payload_conflict', path: file.path };
    }
  }
  return { exists: true, ok: true, reused: true };
}

/**
 * Import a raw Asset archive. The archive is one package/version/target and
 * may contain several generic Asset payloads; no model or runtime naming is
 * interpreted here.
 */
export function importAssetArchive(archivePath, { store = sharedStore() } = {}) {
  if (typeof archivePath !== 'string' || !archivePath) throw new Error('asset_archive_path_required');
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) throw new Error('asset_archive_missing');
  const entries = listArchiveEntries(archivePath);
  if (!entries.includes(ASSET_ARCHIVE_MANIFEST)) throw new Error('asset_archive_manifest_missing');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-os-asset-import-'));
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', stage, '--no-same-owner', '--no-same-permissions'], {
      stdio: 'pipe',
    });
    const manifestPath = path.join(stage, ASSET_ARCHIVE_MANIFEST);
    const metadata = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const assets = normalizeAssets(metadata);
    const expected = expectedArchiveFiles(assets);
    const actualFiles = walkFiles(stage);
    if (!actualFiles.includes(ASSET_ARCHIVE_MANIFEST)) throw new Error('asset_archive_manifest_missing');
    for (const file of actualFiles) {
      if (file !== ASSET_ARCHIVE_MANIFEST && !file.startsWith('payload/')) {
        throw new Error(`asset_archive_unexpected_file:${file}`);
      }
    }
    const payloadFiles = new Set(actualFiles.filter((item) => item.startsWith('payload/')));
    for (const file of payloadFiles) if (!expected.has(file)) throw new Error(`asset_archive_unexpected_file:${file}`);
    for (const file of expected) {
      if (file === 'payload' || file.startsWith('payload/')) continue;
      if (!actualFiles.includes(file)) throw new Error(`asset_archive_file_missing:${file}`);
    }
    for (const asset of assets) {
      for (const file of asset.files) {
        const source = archiveFilePath(stage, asset, file);
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`asset_archive_file_missing:${asset.id}:${file.path}`);
        const st = fs.statSync(source);
        if (st.size !== file.size || sha256File(source) !== file.sha256) {
          throw new Error(`asset_archive_file_mismatch:${asset.id}:${file.path}`);
        }
      }
    }

    const packageRoot = path.resolve(store, metadata.package_id, metadata.version, metadata.target ?? 'generic');
    if (!within(path.resolve(store), packageRoot)) throw new Error('asset_archive_destination_invalid');
    const registry = readRegistry();
    const plan = assets.map((asset) => {
      const finalRoot = path.resolve(packageRoot, asset.payload);
      if (!within(packageRoot, finalRoot)) throw new Error(`asset_archive_destination_invalid:${asset.id}`);
      const existing = existingPayloadMatches(finalRoot, asset);
      if (!existing.ok) throw new Error(`${existing.error}:${asset.id}:${existing.path ?? ''}`);
      const registered = registry.assets?.[asset.id];
      if (registered && (registered.package_id !== metadata.package_id
        || registered.version !== metadata.version
        || registered.target !== (asset.target ?? metadata.target ?? 'generic')
        || path.resolve(String(registered.path ?? '')) !== finalRoot)) {
        throw new Error(`asset_archive_registry_conflict:${asset.id}`);
      }
      return { asset, finalRoot, existing };
    });

    fs.mkdirSync(packageRoot, { recursive: true });
    const imported = [];
    for (const item of plan) {
      if (!item.existing.exists) {
        fs.mkdirSync(path.dirname(item.finalRoot), { recursive: true });
        fs.renameSync(path.join(stage, 'payload', item.asset.payload), item.finalRoot);
      }
      const checksums = Object.fromEntries(item.asset.files.map((file) => [file.path, file.sha256]));
      const files = Object.fromEntries(item.asset.files.map((file) => [file.role, file.path]));
      const entry = activateAsset(item.asset.id, {
        kind: 'asset',
        package_id: metadata.package_id,
        version: metadata.version,
        target: item.asset.target ?? metadata.target ?? 'generic',
        path: item.finalRoot,
        files,
        checksums,
        source: item.asset.source,
        archive: true,
        fetched_on_demand: false,
      });
      imported.push({ id: item.asset.id, path: item.finalRoot, reused: item.existing.reused === true, entry });
    }
    return {
      ok: true,
      schema: ASSET_ARCHIVE_SCHEMA,
      package_id: metadata.package_id,
      version: metadata.version,
      target: metadata.target ?? 'generic',
      assets: imported,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ============================================================
// Self-test: node src/assets/archive.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const crypto = await import('node:crypto');
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-archive-'));
  process.env.ASSETS_REGISTRY_DIR = path.join(root, 'registry');
  const payload = Buffer.from('archive raw bytes');
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'payload', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(source, 'payload', 'raw', 'model.bin'), payload);
  fs.writeFileSync(path.join(source, ASSET_ARCHIVE_MANIFEST), `${JSON.stringify({
    schema: ASSET_ARCHIVE_SCHEMA, package_id: 'pkg.archive', version: '1.0.0', target: 'generic',
    assets: [{ id: 'asset.archive', payload: 'raw', files: [{ path: 'model.bin', size: payload.length, sha256: sha }] }],
  })}\n`);
  const archive = path.join(root, 'sample.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', source, ASSET_ARCHIVE_MANIFEST, 'payload']);
  const result = importAssetArchive(archive, { store: path.join(root, 'models') });
  test('archive imports verified raw bytes', result.ok && fs.existsSync(path.join(root, 'models/pkg.archive/1.0.0/generic/raw/model.bin')));
  const reused = importAssetArchive(archive, { store: path.join(root, 'models') });
  test('identical archive reuses payload safely', reused.ok && reused.assets[0].reused === true);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
