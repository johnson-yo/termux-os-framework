/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/packages/installed-root.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ACTIVE_FILENAME = 'active.json';
export const ACTIVE_SCHEMA = 'termux-os.package-active.v1';

export const installedRoot = () =>
  process.env.PACKAGES_INSTALLED_DIR || path.join(os.homedir(), '.termux-os/packages');

export function resolveInstalledPackages(root = installedRoot()) {
  const entries = [];
  const errors = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')) // .staging 等工作目錄不掃
      .map((d) => d.name).sort();
  } catch { return { entries, errors }; } // 安裝根不存在 = 零安裝，非錯誤
  for (const id of dirs) {
    const dir = path.join(root, id);
    const activePath = path.join(dir, ACTIVE_FILENAME);
    if (!fs.existsSync(activePath)) continue; // 無 active.json = 非安裝包目錄，跳過
    let active;
    try {
      active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    } catch (e) {
      errors.push({ id, dir, error: `active.json parse error: ${String(e?.message ?? e)}` });
      continue;
    }
    if (active.schema !== ACTIVE_SCHEMA || typeof active.active_version !== 'string' || !active.active_version) {
      errors.push({ id, dir, error: `active.json invalid: schema must be ${ACTIVE_SCHEMA} with active_version` });
      continue;
    }
    if (active.id !== id) {
      errors.push({ id, dir, error: `active.json id "${active.id}" does not match directory "${id}"` });
      continue;
    }
    const versionDir = path.join(dir, 'versions', active.active_version);
    if (!fs.existsSync(versionDir)) {
      errors.push({ id, dir, error: `active version directory missing: versions/${active.active_version}` });
      continue;
    }
    entries.push({ id, dir: versionDir, active });
  }
  return { entries, errors };
}
