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
    if (!fs.existsSync(activePath)) {
      // 沒有 active.json 就不是安裝包目錄。但一個有 versions/ 的目錄顯然曾經是——
      // 靜默跳過會讓使用者在管理台上看不到它，卻又刪不掉、裝不回，只能開 shell 才查得出原因。
      if (fs.existsSync(path.join(dir, 'versions'))) {
        errors.push({ id, dir, error: `${ACTIVE_FILENAME} is missing; the Package cannot be loaded until it is reinstalled` });
      }
      continue;
    }
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
    // packageRoot 跨版本存在，versionDir 不是：Package 自己的設定要放在前者之下才活得過升級。
    entries.push({ id, dir: versionDir, packageRoot: dir, active });
  }
  return { entries, errors };
}
