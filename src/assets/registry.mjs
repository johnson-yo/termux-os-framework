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

export const REGISTRY_SCHEMA = 'termux-os.asset-registry.v1';
export const REGISTRY_FILENAME = 'registry.v1.json';

export const registryDir = () => process.env.ASSETS_REGISTRY_DIR
  || path.join(os.homedir(), '.termux-os/assets');
export const registryPath = () => path.join(registryDir(), REGISTRY_FILENAME);

/**
 * 共享 Model Store（024 §5）：模型統一在 /sdcard/termux-os/models；cache 另在相鄰 caches。
 * com.termux_os.app 讀不到 Termux 私有目錄。同一條 022 邊界仍在：只新建、不覆蓋既有內容。
 */
export const sharedStore = () => process.env.SHARED_ASSET_STORE || '/sdcard/termux-os/models';

/** 不可變版本目錄（§5）：<store>/<package-id>/<version>/<target>/ */
export const assetVersionDir = (packageId, version, target) => path.join(sharedStore(), packageId, version, target);

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
  } catch {
    return { schema: REGISTRY_SCHEMA, assets: {} }; // 尚未安裝任何 asset = 空登記，不是錯誤
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
  t('corrupt registry = empty, not crash', Object.keys(readRegistry().assets).length === 0);

  const f = path.join(tmp, 'f.bin');
  fs.writeFileSync(f, 'hello');
  t('sha256File matches known digest',
    sha256File(f) === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  t('assetVersionDir is immutable-versioned',
    assetVersionDir('pkg', '0.1.0', 'tgt') === path.join(tmp, 'store/pkg/0.1.0/tgt'));

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
