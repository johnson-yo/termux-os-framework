/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Installed Package roots and the read-only `.models/<owner>/<repository>` declaration contract.
 * [OUTPUT]: Explicit model-consumer declarations with per-Package validation status.
 * [POS]: src/packages/model-declarations.mjs in termux-os-framework.
 * [PROTOCOL]: This is a generic Package seam; it contains no model-specific registry or runtime policy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveInstalledPackages, installedRoot } from './installed-root.mjs';

export const MODEL_DECLARATION_SCHEMA = 'termux-os.model-declarations.v1';

const validComponent = (value) => typeof value === 'string'
  && value.length > 0
  && value !== '.'
  && value !== '..'
  && !value.includes('/')
  && !value.includes('\\')
  && !value.startsWith('.')
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

const isSafeDirEntry = (entry) => entry?.isDirectory?.() === true || entry?.isFile?.() === true;

/**
 * Read one Package's declarations. A malformed declaration is returned as an
 * explicit error so callers never confuse "not declared" with "could not read".
 */
export function readPackageModelDeclarations(packageRecord) {
  const packageRoot = packageRecord?.packageRoot;
  const packageId = packageRecord?.id ?? null;
  if (typeof packageRoot !== 'string' || !packageRoot) {
    return { package_id: packageId, present: false, declarations: [], errors: [{ error: 'package_root_missing' }] };
  }
  const modelsRoot = path.join(packageRoot, '.models');
  let rootStat;
  try { rootStat = fs.lstatSync(modelsRoot); } catch (error) {
    if (error?.code === 'ENOENT') {
      return { package_id: packageId, active_version: packageRecord?.active?.active_version ?? null,
        present: false, declarations: [], errors: [] };
    }
    return { package_id: packageId, active_version: packageRecord?.active?.active_version ?? null,
      present: true, declarations: [], errors: [{ error: 'models_root_unreadable', detail: String(error?.message ?? error) }] };
  }
  if (!rootStat.isDirectory()) {
    return { package_id: packageId, active_version: packageRecord?.active?.active_version ?? null,
      present: true, declarations: [], errors: [{ error: 'models_root_not_directory', path: '.models' }] };
  }

  const declarations = [];
  const errors = [];
  let owners;
  try { owners = fs.readdirSync(modelsRoot, { withFileTypes: true }); } catch (error) {
    return { package_id: packageId, active_version: packageRecord?.active?.active_version ?? null,
      present: true, declarations: [], errors: [{ error: 'models_root_unreadable', detail: String(error?.message ?? error) }] };
  }
  for (const ownerEntry of owners.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isSafeDirEntry(ownerEntry) || !ownerEntry.isDirectory() || !validComponent(ownerEntry.name)) {
      errors.push({ error: 'invalid_owner', path: path.posix.join('.models', ownerEntry.name) });
      continue;
    }
    const ownerDir = path.join(modelsRoot, ownerEntry.name);
    let repositories;
    try { repositories = fs.readdirSync(ownerDir, { withFileTypes: true }); } catch (error) {
      errors.push({ error: 'owner_unreadable', owner: ownerEntry.name, detail: String(error?.message ?? error) });
      continue;
    }
    for (const repositoryEntry of repositories.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join('.models', ownerEntry.name, repositoryEntry.name);
      if (!validComponent(repositoryEntry.name) || !repositoryEntry.isFile()) {
        errors.push({ error: 'invalid_repository_declaration', path: relative });
        continue;
      }
      declarations.push({
        source: 'huggingface',
        owner: ownerEntry.name,
        repository: repositoryEntry.name,
        identity: `${ownerEntry.name}/${repositoryEntry.name}`,
        path: relative,
      });
    }
  }
  return {
    package_id: packageId,
    active_version: packageRecord?.active?.active_version ?? null,
    present: true,
    declarations,
    errors,
  };
}

/**
 * Enumerate declarations from the current installed Package roots.
 * `resolveInstalledPackages` already validates active pointers; its errors are
 * kept visible here rather than converted to an empty consumer list.
 */
export function listModelDeclarations(root = installedRoot()) {
  const resolved = resolveInstalledPackages(root);
  const packages = resolved.entries.map(readPackageModelDeclarations);
  const errors = resolved.errors.map((error) => ({
    package_id: error.id ?? null,
    error: 'invalid_installed_package',
    detail: error.error ?? null,
  }));
  let rootPresent = false;
  try { rootPresent = fs.statSync(root).isDirectory(); } catch { /* missing root is a valid empty install */ }
  return {
    schema: MODEL_DECLARATION_SCHEMA,
    available: true,
    root: rootPresent ? root : null,
    root_present: rootPresent,
    packages,
    errors,
    declarations: packages.flatMap((item) => item.declarations.map((declaration) => ({
      ...declaration,
      package_id: item.package_id,
      active_version: item.active_version,
    }))),
  };
}

// ============================================================
// Self-test: node src/packages/model-declarations.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-declarations-'));
  const packageRoot = path.join(root, 'pkg.example');
  fs.mkdirSync(path.join(packageRoot, 'versions', '1.0.0'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'active.json'), JSON.stringify({
    schema: 'termux-os.package-active.v1', id: 'pkg.example', active_version: '1.0.0',
  }));
  fs.mkdirSync(path.join(packageRoot, '.models', 'owner'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, '.models', 'owner', 'repository'), '');
  const result = listModelDeclarations(root);
  test('valid declaration is enumerated', result.declarations.length === 1
    && result.declarations[0].identity === 'owner/repository');
  test('declaration is tied to its Package', result.declarations[0].package_id === 'pkg.example');
  fs.mkdirSync(path.join(packageRoot, '.models', 'owner', 'bad'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, '.models', 'owner', 'bad', 'entry'), '');
  const invalid = listModelDeclarations(root);
  test('bad nested path is visible as an error', invalid.packages[0].errors.some((e) => e.error === 'invalid_repository_declaration'));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
