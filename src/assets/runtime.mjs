/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/assets/runtime.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { describeAsset, resolveAsset as resolveFromRegistry, listResolvedAssets } from './resolver.mjs';
import { checkFreeSpace, fetchAssetFiles, pendingBytes } from './fetch.mjs';

const providers = new Map(); // assetId → { id, kind, package, payload, files }

export function registerAssetProvider(asset) {
  if (!asset?.id) throw new Error('asset provider requires id');
  const existing = providers.get(asset.id);
  if (existing && existing.package !== asset.package) {
    // 與 021 的重複 ID 紅線同源：一律拒絕並指明衝突雙方
    throw new Error(`duplicate asset id "${asset.id}": already provided by ${existing.package}, now ${asset.package}`);
  }
  providers.set(asset.id, { ...asset });
  return providers.get(asset.id);
}

export const clearAssetProviders = () => providers.clear();
// 029 Dev Runtime：卸載 Package 時回收其 asset 宣稱（payload/registry 不動——那是 Installer 的事）
export const unregisterAssetProvider = (id) => providers.delete(id);
export const getAssetProvider = (id) => providers.get(id) ?? null;

/**
 * 全部 asset 的狀態 = 宣稱提供的（providers）∪ 已登記安裝的（registry）。
 * 兩邊都要列：只看 providers 會漏掉「包已卸載但 payload 還在」；
 * 只看 registry 會漏掉「包裝了但 payload 沒裝成」。
 */
export function listAssets(opts = {}) {
  const out = new Map();
  for (const d of listResolvedAssets(opts)) out.set(d.id, { ...d, declared_by: providers.get(d.id)?.package ?? null });
  for (const [id, p] of providers) {
    if (out.has(id)) { out.get(id).kind = p.kind; continue; }
    out.set(id, { ...describeAsset(id, opts), kind: p.kind, declared_by: p.package });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const resolveAsset = (id, opts = {}) => resolveFromRegistry(id, opts);

/**
 * 按需取一個**可選**資產。
 *
 * ⭐ 坐標全部來自宣告它的那個 Package 的 Manifest——調用方只給一個 id，不給 URL。
 * 讓調用方傳路徑會讓「這台機器上的這個資產到底是什麼」變成一個沒人答得出的問題。
 *
 * ⛔ 只有 `optional: true` 的資產走這條路。必需資產在安裝時就該到位；
 * 允許事後補取會讓「裝好了」這個狀態失去意義。
 */
export async function fetchOptionalAsset(id, {
  packageManifest,
  storeDirFor,
  activate,
  via = 'registry',
  registryBase = '',
  onProgress = () => {},
} = {}) {
  const declared = (packageManifest?.assets?.provides ?? []).find((a) => a.id === id);
  if (!declared) return { ok: false, error: 'unknown_asset', detail: `${id} is not declared by this package` };
  if (declared.optional !== true) {
    return { ok: false, error: 'not_optional', detail: `${id} is installed with its package, not fetched on demand` };
  }
  const files = declared.source?.files ?? [];
  if (!files.length) return { ok: false, error: 'no_remote_source', detail: `${id} has no source.files to fetch` };

  const destDir = storeDirFor(declared);
  const need = pendingBytes(files, destDir);
  const space = checkFreeSpace(destDir, need);
  if (!space.ok) {
    return { ok: false, error: 'insufficient_space', need_bytes: need, free_bytes: space.free_bytes };
  }
  await fetchAssetFiles(files, destDir, { via, registryBase, onProgress });
  const entry = activate(declared, destDir, Object.fromEntries(files.map((f) => [f.path, f.sha256])));
  return { ok: true, id, path: destDir, bytes: need, entry };
}
export { describeAsset };

// ============================================================
// 自檢：node src/assets/runtime.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assetrt-'));
  process.env.ASSETS_REGISTRY_DIR = path.join(tmp, 'reg');

  registerAssetProvider({ id: 'model.a', kind: 'model', package: 'pkg.a', payload: 'payload/a', files: {} });
  t('provider registered', getAssetProvider('model.a').package === 'pkg.a');
  t('same package re-register is idempotent',
    !!registerAssetProvider({ id: 'model.a', kind: 'model', package: 'pkg.a', payload: 'payload/a', files: {} }));
  let threw = false;
  try { registerAssetProvider({ id: 'model.a', kind: 'model', package: 'pkg.b' }); } catch { threw = true; }
  t('duplicate asset id from another package rejected', threw);

  const list = listAssets({ profile: { os: 'android', arch: 'arm64' } });
  t('declared-but-not-installed shows up as not ready',
    list.length === 1 && list[0].id === 'model.a' && list[0].ready === false
    && list[0].reason === 'missing_asset:model.a' && list[0].declared_by === 'pkg.a');

  clearAssetProviders();
  t('clear empties providers', listAssets().length === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
