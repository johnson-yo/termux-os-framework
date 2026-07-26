/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package enablement preferences and the private Framework state path.
 * [OUTPUT]: Persistent Package Setting state used by the loader and Admin API.
 * [POS]: src/system/package-settings.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE_SETTINGS_SCHEMA = 'termux-os.package-settings.v1';
const ID_RE = /^[\w.@-]+$/;

let config = { path: null };
let state = { schema: PACKAGE_SETTINGS_SCHEMA, packages: {}, updated_at: null };

function readState() {
  if (!config.path) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(config.path, 'utf8'));
    if (parsed?.schema === PACKAGE_SETTINGS_SCHEMA
      && parsed.packages && typeof parsed.packages === 'object' && !Array.isArray(parsed.packages)) {
      state = { schema: PACKAGE_SETTINGS_SCHEMA, packages: parsed.packages, updated_at: parsed.updated_at ?? null };
    }
  } catch { /* Missing or corrupt settings use safe defaults and are replaced on the next write. */ }
}

function writeState() {
  if (!config.path) return;
  fs.mkdirSync(path.dirname(config.path), { recursive: true, mode: 0o700 });
  const tmp = `${config.path}.${process.pid}.tmp`;
  const next = { ...state, updated_at: new Date().toISOString() };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, config.path);
    fs.chmodSync(config.path, 0o600);
    state = next;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function assertPackageId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid package id');
  return id;
}

export function configurePackageSettings(opts = {}) {
  config = { path: opts.path ? path.resolve(opts.path) : null };
  state = { schema: PACKAGE_SETTINGS_SCHEMA, packages: {}, updated_at: null };
  readState();
  return packageSettingsSnapshot();
}

/** An absent preference means enabled: the safe default for installed Packages. */
export const isPackageEnabled = (id) => state.packages[id]?.enabled !== false;

export function getPackageSetting(id) {
  assertPackageId(id);
  const item = state.packages[id];
  return {
    schema: PACKAGE_SETTINGS_SCHEMA,
    package_id: id,
    enabled: isPackageEnabled(id),
    updated_at: item?.updated_at ?? null,
  };
}

export function setPackageEnabled(id, enabled) {
  assertPackageId(id);
  if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
  state.packages[id] = {
    ...(state.packages[id] ?? {}),
    enabled,
    updated_at: new Date().toISOString(),
  };
  writeState();
  return getPackageSetting(id);
}

export function listPackageSettings() {
  return Object.keys(state.packages).sort().map((id) => getPackageSetting(id));
}

export function packageSettingsSnapshot() {
  return {
    schema: PACKAGE_SETTINGS_SCHEMA,
    packages: listPackageSettings(),
    updated_at: state.updated_at,
  };
}

if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'framework-package-settings-'));
  const file = path.join(tmp, 'package-settings.json');
  let fails = 0;
  const t = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fails++; };

  configurePackageSettings({ path: file });
  const id = 'github.example.service.demo';
  t('missing Package defaults to enabled', isPackageEnabled(id));
  setPackageEnabled(id, false);
  t('disabled preference persists in memory', !isPackageEnabled(id));
  t('settings file is private', (fs.statSync(file).mode & 0o777) === 0o600);
  configurePackageSettings({ path: file });
  t('disabled preference survives reload', !isPackageEnabled(id));
  setPackageEnabled(id, true);
  t('enable preference restores default behavior', isPackageEnabled(id));
  t('snapshot has stable schema', packageSettingsSnapshot().schema === PACKAGE_SETTINGS_SCHEMA);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
