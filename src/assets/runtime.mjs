/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/assets/runtime.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describeAsset, resolveAsset as resolveFromRegistry, listResolvedAssets } from './resolver.mjs';
import { checkFreeSpace, fetchAssetFiles, pendingBytes } from './fetch.mjs';
import { selectAssetDeclaration } from '../packages/manifest.mjs';
import { deviceProfile } from '../packages/runtime-contract.mjs';

const providers = new Map(); // assetId → { id, kind, package, payload, files }

/** 往上走到第一個存在的祖先目錄；到根還是沒有就回根。 */
function nearestExisting(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(d)) return d;
    const up = path.dirname(d);
    if (up === d) return d;
    d = up;
  }
}

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
 * ⛔ 默认只有 `optional: true` 的資產走這條路。必需資產在安裝時就該到位；
 * 允許一般调用方事後補取會讓「裝好了」這個狀態失去意義。
 *
 * `allowRequired` 只由 Framework 的「逻辑模型恢复」受限入口传入。它不是
 * Package context 的通用开关：恢复前必须由上层完成停用，并携带逻辑模型语义，
 * 让“删掉后恢复”与“任意包偷偷补齐必需资产”保持可区分。
 */
export async function fetchOptionalAsset(id, {
  packageManifest,
  storeDirFor,
  activate,
  profile = null,
  via = 'registry',
  registryBase = '',
  onProgress = () => {},
  allowRequired = false,
  fetchImpl = fetch,
  signal = undefined,
} = {}) {
  /**
   * ⭐ 先挑硬件檔位，再談取不取。同一個 id 可以有 V73/V79 兩份宣告，而這台機器只有一份能用。
   * 挑不出來時回的是 `target_mismatch` 而不是 `unknown_asset`——「沒有給你這台機器的版本」
   * 與「根本沒這個資產」要分開，前者的下一步是去編一份，後者是裝錯了包。
   */
  const picked = selectAssetDeclaration(packageManifest, id, profile ?? deviceProfile());
  if (!picked.ok) return { ok: false, error: picked.error, detail: picked.detail, candidates: picked.candidates };
  const declared = picked.declaration;
  if (declared.optional !== true && !allowRequired) {
    return { ok: false, error: 'not_optional', detail: `${id} is installed with its package, not fetched on demand` };
  }
  const files = declared.source?.files ?? [];
  if (!files.length) return { ok: false, error: 'no_remote_source', detail: `${id} has no source.files to fetch` };
  /**
   * ⚠ 走 Catalog 卻沒有 Catalog 地址時**必須當場失敗**。
   *
   * `assetFileUrl` 是字串拼接，空的 base 會拼出相對路徑 `/download?...`，
   * 而這只在真的要下載時才炸——已經就位的檔案因為 sha 相符被直接複用，一次 URL 都不構造。
   * 也就是說：唯一會發現這個問題的路徑，正是最不容易被測到的那條。
   */
  if (via === 'registry' && !registryBase) {
    return { ok: false, error: 'no_registry_base', detail: 'fetching through the catalog needs its base URL' };
  }

  const destDir = storeDirFor(declared);
  const need = pendingBytes(files, destDir);
  /**
   * ⚠ 對**還不存在**的目錄問剩餘空間，`statfs` 會失敗，而失敗被當成「不知道，放行」。
   * 首次下載的目錄本來就不存在——也就是說最需要這道檢查的那一次，它剛好不生效。
   * 故往上走到第一個真的存在的祖先再問；同一個檔案系統，答案一樣。
   */
  const space = checkFreeSpace(nearestExisting(destDir), need);
  if (!space.ok) {
    return { ok: false, error: 'insufficient_space', need_bytes: need, free_bytes: space.free_bytes };
  }
  await fetchAssetFiles(files, destDir, { via, registryBase, onProgress, fetchImpl, signal });
  const entry = activate(declared, destDir, Object.fromEntries(files.map((f) => [f.path, f.sha256])));
  return { ok: true, id, path: destDir, bytes: need, entry };
}
export { describeAsset };

// ============================================================
// 自檢：node src/assets/runtime.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
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

  // --- 同一個 id 的多個硬件檔位：挑對那一份，挑不出來要說得出為什麼 ---
  const crypto = await import('node:crypto');
  const v73 = { os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.47' };
  const store = path.join(tmp, 'store');
  const variant = (htp) => {
    const body = Buffer.from(`ctx for ${htp}`);
    return {
      id: 'model.ctx',
      kind: 'model',
      optional: true,
      payload: `ctx-${htp}`,
      files: { context: 'm.bin' },
      target: { id: `android-arm64-${htp}-qnn247`, os: 'android', arch: 'arm64', htp, qnn: '2.47' },
      source: {
        files: [{
          path: 'm.bin',
          repo: 'o/r',
          revision: 'b'.repeat(40),
          size: body.length,
          sha256: crypto.createHash('sha256').update(body).digest('hex'),
          body, // 只給自檢的假 fetch 用
        }],
      },
    };
  };
  // v79 故意排在前面：挑錯的實現會拿到第一個，而它在這台機器上是廢的。
  const manifest = { assets: { provides: [variant('v79'), variant('v73')] } };
  const served = (file) => ({
    ok: true,
    status: 200,
    body: (async function* one() { yield file.body; }()),
  });

  let activated = null;
  const fetched = await fetchOptionalAsset('model.ctx', {
    packageManifest: manifest,
    profile: v73,
    storeDirFor: (d) => path.join(store, d.target.id, d.payload),
    activate: (d, dir) => { activated = { target: d.target.id, dir }; return activated; },
    via: 'direct',
    fetchImpl: async () => served(manifest.assets.provides[1].source.files[0]),
  });
  t('the device gets its own hardware variant, not the first one declared',
    fetched.ok === true && activated.target === 'android-arm64-v73-qnn247');
  t('two variants land in separate directories — a wrapper cannot name its own hardware',
    fs.existsSync(path.join(store, 'android-arm64-v73-qnn247/ctx-v73/m.bin'))
    && !fs.existsSync(path.join(store, 'android-arm64-v79-qnn247')));

  const noMatch = await fetchOptionalAsset('model.ctx', {
    packageManifest: manifest,
    profile: { os: 'android', arch: 'arm64', htp: 'v75', qnn: '2.47' },
    storeDirFor: () => store,
    activate: () => null,
  });
  t('an unbuilt hardware variant is a target_mismatch, never a silent wrong download',
    noMatch.ok === false && noMatch.error === 'target_mismatch:model.ctx'
    && noMatch.candidates.join(',') === 'android-arm64-v79-qnn247,android-arm64-v73-qnn247');
  t('the mismatch says what the device is, so the next step is knowable',
    /htp: target wants "v73", device has "v75"/.test(noMatch.detail));

  const notDeclared = await fetchOptionalAsset('model.ghost', {
    packageManifest: manifest, profile: v73, storeDirFor: () => store, activate: () => null,
  });
  t('"no variant for this device" and "no such asset" stay different answers',
    notDeclared.error === 'unknown_asset');

  /**
   * ⭐ 這一條抓的是一個真的漏出去過的缺陷：走 Catalog 卻沒有 base，
   * `assetFileUrl` 會拼出相對路徑 `/download?...`。它只在**真的要下載**時才炸，
   * 而已就位的檔案因 sha 相符被直接複用、一次 URL 都不構造——
   * 於是第一次驗收（字節已預置）全綠，下載路徑一次都沒走過。
   */
  const noBase = await fetchOptionalAsset('model.ctx', {
    packageManifest: manifest, profile: v73, storeDirFor: () => path.join(tmp, 'nobase'),
    activate: () => null, via: 'registry', registryBase: '',
  });
  t('fetching through the catalog without its address fails now, not mid-download',
    noBase.ok === false && noBase.error === 'no_registry_base');

  const required = await fetchOptionalAsset('model.req', {
    packageManifest: { assets: { provides: [{ id: 'model.req', kind: 'model', payload: 'r', files: {} }] } },
    profile: v73, storeDirFor: () => store, activate: () => null,
  });
  t('a required asset is still refused on demand — installed means installed',
    required.error === 'not_optional');

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
