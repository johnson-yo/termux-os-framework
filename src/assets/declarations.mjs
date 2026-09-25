/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Active Installed Root Package manifests and optional Dev Mount records.
 * [OUTPUT]: A derived Asset Declaration Index; no payload bytes or lifecycle state are written here.
 * [POS]: src/assets/declarations.mjs in termux-os-framework.
 * [PROTOCOL]: Declarations describe what an active Package provides. Payload selection and bytes live elsewhere.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstalledPackages, installedRoot } from '../packages/installed-root.mjs';
import { DEVICE_TARGET, resolveAssetTarget } from '../packages/manifest.mjs';
import { deviceProfile } from '../packages/runtime-contract.mjs';

// The probe spawns processes; a device does not change its SoC or bundled QNN while running.
let cachedProfile = null;
const currentProfile = () => (cachedProfile ??= deviceProfile());

export const DECLARATION_INDEX_SCHEMA = 'termux-os.asset-declarations.v2';
export const GENERIC_VARIANT = 'generic';

const packageLabel = (record) => record?.id ?? record?.package_id ?? null;

/**
 * Return the stable variant identity used by the Selection map. A target is a
 * declaration fact, not a Manager recommendation; generic is the only
 * implicit target retained for compatibility with old manifests.
 */
export const declarationVariantId = (asset) => asset?.target?.id ?? GENERIC_VARIANT;

const copyFiles = (files) => (files && typeof files === 'object' && !Array.isArray(files))
  ? Object.fromEntries(Object.entries(files).filter(([, value]) => typeof value === 'string' && value))
  : {};

/**
 * Derive declarations from one already-selected active manifest. Keeping this
 * function pure lets Package install, Core startup, and fixture tests use the
 * same shape without creating a second persistent declaration ledger.
 */
export function declarationsFromManifest({
  packageId,
  packageVersion = null,
  versionRoot = null,
  manifest,
  provenance = 'installed_manifest',
  profile = null,
} = {}) {
  if (!manifest || typeof manifest !== 'object') return [];
  const id = packageId ?? manifest.id ?? null;
  const version = packageVersion ?? manifest.version ?? null;
  return (manifest.assets?.provides ?? []).filter((asset) => asset && typeof asset.id === 'string' && asset.id)
    .map((declared) => (declared.target === DEVICE_TARGET
      ? resolveAssetTarget(declared, profile ?? currentProfile())
      : declared))
    .map((asset) => {
      const variantId = declarationVariantId(asset);
      return {
        schema: 'termux-os.asset-declaration.v2',
        declaration_id: `${id ?? 'unknown'}@${version ?? 'unknown'}:${asset.id}:${variantId}`,
        asset_id: asset.id,
        variant_id: variantId,
        kind: asset.kind ?? null,
        optional: asset.optional === true,
        package_id: id,
        package_version: version,
        package_root: versionRoot,
        payload: asset.payload ?? null,
        files: copyFiles(asset.files),
        target: asset.target ?? null,
        // `device` variants carry no files here: the catalog owns them, per target.
        target_mode: asset.target_mode ?? null,
        source: asset.source ?? null,
        provenance,
      };
    });
}

const readManifest = (record) => {
  const root = record?.versionRoot ?? record?.dir ?? null;
  const id = packageLabel(record);
  if (!root) return { ok: false, package_id: id, error: 'package_root_missing' };
  const manifestPath = path.join(root, 'termux-os.package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { ok: true, package_id: id, root, manifest };
  } catch (error) {
    return {
      ok: false,
      package_id: id,
      root,
      error: 'package_manifest_unreadable',
      detail: String(error?.message ?? error),
    };
  }
};

const normalizeDevMount = (mount) => {
  if (!mount || typeof mount !== 'object') return null;
  if (mount.manifest) return mount;
  return null;
};

/**
 * Build the current index from the active Installed Root. The index is a
 * read-only projection: a Package update/rollback changes the next scan, and
 * uninstall removes its declarations without touching payload objects.
 */
export function readDeclarationIndex({
  root = installedRoot(),
  packageEntries = null,
  devMounts = [],
} = {}) {
  const discovered = packageEntries ?? resolveInstalledPackages(root).entries;
  const scanErrors = packageEntries ? [] : resolveInstalledPackages(root).errors;
  const declarations = [];
  const packages = [];
  const errors = [...scanErrors];

  for (const record of discovered) {
    const read = readManifest(record);
    if (!read.ok) {
      packages.push({ package_id: read.package_id, path: read.root ?? null, declarations: [], errors: [{ error: read.error, detail: read.detail ?? null }] });
      errors.push({ package_id: read.package_id, error: read.error, detail: read.detail ?? null });
      continue;
    }
    const packageDeclarations = declarationsFromManifest({
      packageId: read.package_id,
      packageVersion: read.manifest.version ?? record?.active?.active_version ?? null,
      versionRoot: read.root,
      manifest: read.manifest,
    });
    packages.push({
      package_id: read.package_id,
      active_version: record?.active?.active_version ?? read.manifest.version ?? null,
      path: read.root,
      declarations: packageDeclarations.map((item) => item.declaration_id),
      errors: [],
    });
    declarations.push(...packageDeclarations);
  }

  for (const mount of devMounts.map(normalizeDevMount).filter(Boolean)) {
    const packageDeclarations = declarationsFromManifest({
      packageId: mount.packageId ?? mount.package_id ?? mount.manifest.id,
      packageVersion: mount.packageVersion ?? mount.package_version ?? mount.manifest.version ?? null,
      versionRoot: mount.versionRoot ?? mount.root ?? null,
      manifest: mount.manifest,
      provenance: 'dev_mount',
    });
    declarations.push(...packageDeclarations);
    packages.push({
      package_id: mount.packageId ?? mount.package_id ?? mount.manifest.id ?? null,
      active_version: mount.packageVersion ?? mount.package_version ?? mount.manifest.version ?? null,
      path: mount.versionRoot ?? mount.root ?? null,
      declarations: packageDeclarations.map((item) => item.declaration_id),
      errors: [],
      provenance: 'dev_mount',
    });
  }

  const seen = new Map();
  for (const declaration of declarations) {
    const key = `${declaration.asset_id}\u0000${declaration.variant_id}`;
    const previous = seen.get(key);
    if (previous && previous.package_id !== declaration.package_id) {
      errors.push({
        error: 'duplicate_asset_declaration',
        asset_id: declaration.asset_id,
        variant_id: declaration.variant_id,
        packages: [previous.package_id, declaration.package_id],
      });
    } else {
      seen.set(key, declaration);
    }
  }

  declarations.sort((a, b) => a.declaration_id.localeCompare(b.declaration_id));
  packages.sort((a, b) => String(a.package_id ?? '').localeCompare(String(b.package_id ?? '')));
  return {
    schema: DECLARATION_INDEX_SCHEMA,
    generated_at: new Date().toISOString(),
    root,
    declarations,
    packages,
    errors,
  };
}

export const declarationsForAsset = (index, assetId) => (index?.declarations ?? [])
  .filter((item) => item.asset_id === assetId);

export const declarationIndexSnapshot = (opts = {}) => readDeclarationIndex(opts);

// ============================================================
// Self-test: node src/assets/declarations.mjs --self-test
// ============================================================
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-declarations-'));
  const versionRoot = path.join(root, 'pkg.example', 'versions', '1.2.3');
  fs.mkdirSync(versionRoot, { recursive: true });
  fs.writeFileSync(path.join(versionRoot, 'termux-os.package.json'), `${JSON.stringify({
    id: 'pkg.example', version: '1.2.3', assets: { provides: [
      { id: 'model.generic', kind: 'model', payload: 'payload/generic', files: { model: 'model.bin' } },
      { id: 'model.ctx', kind: 'model', optional: true, payload: 'payload/v73', target: {
        id: 'android-arm64-v73-qnn247', os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.47',
      }, files: { context: 'model.ctx' } },
    ] },
  })}\n`);
  const index = readDeclarationIndex({ packageEntries: [{
    id: 'pkg.example', versionRoot, dir: versionRoot, active: { active_version: '1.2.3' },
  }] });
  test('active manifest produces declarations without a payload ledger', index.declarations.length === 2);
  test('optional is a declaration fact, not a lifecycle gate', index.declarations.find((d) => d.asset_id === 'model.ctx')?.optional === true);
  test('variant identity is stable and target-specific', index.declarations.find((d) => d.asset_id === 'model.ctx')?.variant_id === 'android-arm64-v73-qnn247');
  test('package root and version remain visible for audit', index.packages[0]?.path === versionRoot
    && index.declarations[0]?.package_id === 'pkg.example');
  const pure = declarationsFromManifest({ packageId: 'pkg.dev', manifest: { id: 'pkg.dev', version: '0.1.0', assets: { provides: [{ id: 'a', kind: 'binary', payload: 'a', files: {} }] } }, provenance: 'dev_mount' });
  test('Dev Mount uses the same derived shape', pure[0]?.provenance === 'dev_mount' && pure[0]?.asset_id === 'a');
  const perDevice = (profile) => declarationsFromManifest({ packageId: 'pkg.catalog', profile, manifest: {
    id: 'pkg.catalog', version: '2.0.0',
    assets: { provides: [{ id: 'model.ctx', kind: 'model', payload: 'ctx', files: { context: 'model.bin' }, target: 'device' }] },
  } })[0];
  const v79 = perDevice({ os: 'android', arch: 'arm64', htp: 'v79', qnn: '2.49' });
  test('a "device" asset declares exactly this device\'s variant',
    v79?.variant_id === 'android-arm64-v79-qnn249' && v79?.target?.htp === 'v79' && v79?.target_mode === 'device');
  test('the same manifest declares another variant on another device',
    perDevice({ os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.49' })?.variant_id === 'android-arm64-v73-qnn249');
  test('an unknown device gets an explicit non-matching variant, never a guessed one',
    perDevice({ os: 'android', arch: 'arm64', htp: 'unknown', qnn: '2.49' })?.variant_id === 'device-unknown');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
