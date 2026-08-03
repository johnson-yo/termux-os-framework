/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/packages/dev-runtime.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSinglePackage, unregisterPackage, _getRecord } from './loader.mjs';
import { hashWorkspace, WORKSPACE_HASH_SKIP as SKIP } from './workspace-hash.mjs';
import * as stage from '../stage/manager.mjs';

export { hashWorkspace };

let CFG = null;               // { frameworkRoot, frameworkVersion, config, configPath, saveConfig, log }
const mounts = new Map();     // id → mount 記錄（見 devMount）

const stateFile = () => path.join(CFG.frameworkRoot, '.runtime/dev/packages.v1.json');
const genRoot = () => path.join(CFG.frameworkRoot, '.runtime/dev/gen');

/**
 * Workspace data always lives in the Framework's private tree, never on shared storage.
 *
 * A Package under development may write audio or images, and anything under /sdcard gets
 * picked up by the Android media scanner and shows up in the user's gallery. Development
 * output must not be able to pollute the device that way. `.runtime` is preserved across
 * Framework updates (see preserve_runtime_state), so this is persistent, not scratch.
 */
const devDataRoot = (id) => path.join(CFG.frameworkRoot, '.runtime/dev-data', id);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * generation 副本：ESM 沒有模塊快取失效——entry 加查詢串只救 entry 自己，
 * 子模塊（./service/*.mjs）URL 不變照舊命中舊快取。每次載入把 Workspace 拷到新目錄，
 * 所有相對 import 都落在新 URL 上 → 整棵樹都是新代碼。舊 generation 隨手刪。
 */
function newGeneration(id, workspace) {
  const dst = path.join(genRoot(), id, String(Date.now()));
  copyTree(workspace, dst);
  return dst;
}

const saveState = () => {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({
    schema: 'termux-os.dev-packages.v1',
    mounts: [...mounts.values()].map(publicMount),
  }, null, 2));
};

const publicMount = (m) => ({
  package_id: m.package_id, instance_id: m.instance_id, workspace_slug: m.workspace_slug,
  workspace: m.workspace, started_at: m.started_at,
  source_hash: m.source_hash, data_mode: m.data_mode,
  // Coexistence removed shadowing; the field stays so older clients keep parsing.
  shadow: null,
  watch_mode: m.watch_mode ?? null, seq: m.seq, last_error: m.last_error ?? null,
  /**
   * 依賴檢查的開發者豁免。⭐ 只存在於 **Dev Mount** 上——正式 Release 沒有這個欄位，
   * 也就無從宣告自己可以跳過依賴檢查。一道能被被檢查者自己關掉的門不是門。
   * 預設 false：開發環境同樣先執行檢查，豁免必須是一次明確的動作。
   */
  dependency_override: m.dependency_override === true,
});

/**
 * 開關依賴豁免。⚠ 它必須在狀態裡看得見（`publicMount` 已帶）並在每次生效時寫日誌——
 * 一個看不見的豁免會讓「本機能跑、裝到別人機器上不能跑」變成無法解釋的現象。
 */
export function devSetDependencyOverride(idOrInstance, enabled) {
  const id = resolveMountKey(idOrInstance);
  const m = id ? mounts.get(id) : null;
  if (!m) return { ok: false, error: 'not_mounted' };
  m.dependency_override = enabled === true;
  saveState();
  CFG.log(`dev dependency override ${m.dependency_override ? 'enabled' : 'disabled'} for ${id}`);
  return { ok: true, mount: publicMount(m) };
}

// ============================================================
// 生命週期
// ============================================================
export function initDevRuntime(cfg) {
  CFG = cfg;
  // 029 §7.6：重啟不自動恢復 Dev Mount——手機開機不能意外跑未完成代碼；殘留只如實告知
  try {
    const prev = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (prev?.mounts?.length) {
      cfg.log(`dev runtime: ${prev.mounts.length} stale dev mount(s) from previous run NOT restored`
        + `（${prev.mounts.map((m) => m.package_id).join(', ')}——需要就再 dev start）`);
    }
  } catch { /* 無殘留 */ }
  fs.rmSync(stateFile(), { force: true });
  fs.rmSync(genRoot(), { recursive: true, force: true });
}

export const listDevMounts = () => [...mounts.values()].map(publicMount);

/**
 * Mounts are keyed by instance id (`<package-id>@<slug>`), but callers that
 * only ever ran one workspace per package still pass the bare package id.
 * Accept both: exact key first, then the package's sole mount. Ambiguity
 * (two workspaces of the same package) returns null so the caller must be
 * explicit rather than silently acting on whichever one came first.
 */
export function resolveMountKey(idOrInstance) {
  if (mounts.has(idOrInstance)) return idOrInstance;
  const owned = [...mounts.values()].filter((m) => m.package_id === idOrInstance);
  return owned.length === 1 ? owned[0].instance_id : null;
}

export const getDevMount = (id) => {
  const key = resolveMountKey(id);
  return key ? publicMount(mounts.get(key)) : null;
};

/**
 * Exact-key check. It must NOT resolve a bare package id to its workspace
 * mount: this answers "is *this* record a workspace instance", and it decides
 * whether the DEV banner is injected and whether package mutations are refused.
 * Resolving loosely here marks the released package as a dev mount — its page
 * gets the banner and its lifecycle actions get refused.
 */
export const isDevMounted = (id) => mounts.has(id);

/** 瀏覽器輪詢口：seq 變了就刷新（web 改動/重載都會 bump） */
export const devEvents = (id) => {
  const m = mounts.get(resolveMountKey(id) ?? id);
  if (!m) return null;
  const r = _getRecord(id);
  return { seq: m.seq, status: r?.status ?? 'unknown', error: r?.error ?? null };
};

/** 停掉某包已註冊的 Stage Service；返回停之前在跑的 id 清單（恢復時要照樣拉起） */
async function stopPackageServices(id) {
  const r = _getRecord(id);
  if (!r) return [];
  const live = await stage.listServices();
  const wasRunning = [];
  for (const sid of r.registered.services) {
    const svc = live.find((s) => s.id === sid);
    if (svc?.process?.state === 'running') wasRunning.push(sid);
    await stage.stopService(sid, { preserveDesired: true }); // 系統性停靠不動用戶意圖
  }
  return wasRunning;
}

/** Workspace slug: URL- and id-safe, derived from the requested name or the workspace dir. */
export function toSlug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

export async function devMount(id, { workspace, dataMode = 'isolated', slug: requested = null }) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized' };
  const ws = path.resolve(workspace);
  const slug = toSlug(requested ?? path.basename(ws)) || 'dev';

  // 先驗後動：Manifest 缺失/ID 不符在動任何現場之前拒絕
  const manifestPath = path.join(ws, 'termux-os.package.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: 'workspace_has_no_manifest', detail: manifestPath };
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, error: 'manifest_parse_error', detail: String(e?.message ?? e) }; }
  if (manifest.id !== id) {
    return { ok: false, error: 'manifest_id_mismatch', detail: `workspace manifest id=${manifest.id}, requested ${id}` };
  }

  // Coexistence: the workspace loads as its own instance `<id>@<slug>`, so the
  // released package keeps serving throughout. Nothing is stopped, unregistered
  // or shadowed — a developer can compare the two side by side, and a broken
  // workspace can never take the working copy down with it.
  const instanceId = `${id}@${slug}`;
  if (_getRecord(instanceId)) {
    return { ok: false, error: 'already_mounted', fix: `dev reload ${instanceId} 或先 dev stop` };
  }

  const gen = newGeneration(instanceId, ws);
  // A workspace instance always gets its own persist root. `live` would mean
  // writing the released package's persisted config, which is exactly the
  // cross-contamination coexistence is meant to remove.
  const overrides = { devMode: true, persistRoot: devDataRoot(instanceId) };
  const record = await loadSinglePackage(
    { dir: gen, expectId: instanceId, source: 'dev-mount', contextOverrides: overrides,
      cacheBust: true, workspaceSlug: slug }, CFG);

  const m = {
    package_id: id, instance_id: instanceId, workspace_slug: slug,
    workspace: ws, started_at: new Date().toISOString(),
    source_hash: hashWorkspace(ws), data_mode: dataMode, gen, shadow: null,
    restart_services: [], seq: 1, last_error: record?.error ?? null,
  };
  mounts.set(instanceId, m);
  if (record) record.dev = publicMount(m);
  if (record?.status === 'loaded') {
    // web 資源直讀 Workspace（S4 live 編輯）；backend 跑 generation 副本
    record.webRoot = path.join(ws, path.dirname(record.manifest.entrypoints.webui));
  }
  startWatcher(m);
  saveState();
  return { ok: record?.status === 'loaded', status: record?.status ?? 'failed',
    error: record?.error ?? null, mount: publicMount(m) };
}

export async function devReload(idOrInstance, { reason = 'manual' } = {}) {
  const id = resolveMountKey(idOrInstance);
  const m = id ? mounts.get(id) : null;
  if (!m) return { ok: false, error: 'not_mounted' };
  const wasRunning = await stopPackageServices(id);
  await unregisterPackage(id);
  const oldGen = m.gen;
  m.gen = newGeneration(id, m.workspace);
  const overrides = { devMode: true, persistRoot: devDataRoot(id) };
  const record = await loadSinglePackage(
    { dir: m.gen, expectId: id, source: 'dev-mount', contextOverrides: overrides,
      cacheBust: true, workspaceSlug: m.workspace_slug }, CFG);
  fs.rmSync(oldGen, { recursive: true, force: true });
  m.source_hash = hashWorkspace(m.workspace);
  m.seq += 1;
  m.last_error = record?.error ?? null;
  if (record) record.dev = publicMount(m);
  if (record?.status === 'loaded') {
    record.webRoot = path.join(m.workspace, path.dirname(record.manifest.entrypoints.webui));
    for (const sid of wasRunning) {
      if (record.registered.services.includes(sid)) await stage.startService(sid);
    }
  }
  saveState();
  CFG.log(`dev reload ${id} (${reason}): ${record?.status ?? 'failed'}${record?.error ? ` — ${record.error}` : ''}`);
  return { ok: record?.status === 'loaded', status: record?.status ?? 'failed', error: record?.error ?? null };
}

export async function devUnmount(idOrInstance) {
  const id = resolveMountKey(idOrInstance);
  const m = id ? mounts.get(id) : null;
  if (!m) return { ok: false, error: 'not_mounted' };
  stopWatcher(m);
  await stopPackageServices(id);
  await unregisterPackage(id);
  fs.rmSync(path.join(genRoot(), id), { recursive: true, force: true });
  // Nothing to restore: coexistence means the released package was never
  // displaced, so unmounting only removes the workspace instance.
  mounts.delete(id);
  saveState();
  return { ok: true, restored: null, workspace_kept: m.workspace };
}

// ============================================================
// Watcher（029 §8）：優先 fs.watch，失敗回退 mtime polling；web/ 改動只 bump seq，
// backend 改動 debounce 後整包重載。watcher 失靈時 dev reload 是正式 fallback。
// ============================================================
function classifyChange(m, relPath) {
  if (!relPath) return 'backend'; // 事件沒帶路徑就保守整包重載
  const top = relPath.split(path.sep)[0];
  if (SKIP.has(top)) return null;
  const r = _getRecord(m.package_id);
  const webDir = r?.manifest ? path.dirname(r.manifest.entrypoints.webui) : 'web';
  return relPath.startsWith(`${webDir}${path.sep}`) || relPath.startsWith(`${webDir}/`) ? 'web' : 'backend';
}

function onFsChange(m, relPath) {
  const kind = classifyChange(m, relPath);
  if (!kind) return;
  if (kind === 'web') { m.seq += 1; return; }
  clearTimeout(m.debounce);
  m.debounce = setTimeout(() => { devReload(m.instance_id, { reason: `file change: ${relPath}` }); }, 600);
}

function snapshotMtimes(dir) {
  const map = new Map();
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) { try { map.set(r, fs.statSync(path.join(d, e.name)).mtimeMs); } catch { /* 中途被刪 */ } }
    }
  };
  walk(dir, '');
  return map;
}

function startWatcher(m) {
  try {
    // TERMUX_OS_DEV_POLL=1 強制走 polling（共享存儲上 fs.watch 假活比不活更糟——事件靜默丟失）
    if (process.env.TERMUX_OS_DEV_POLL === '1') throw new Error('forced polling');
    m.watcher = fs.watch(m.workspace, { recursive: true }, (_ev, fname) => onFsChange(m, fname ?? null));
    m.watch_mode = 'fs-watch';
  } catch {
    // Android/共享存儲上 fs.watch 不可靠——低頻 mtime polling 回退（029 §8.5）
    m.mtimes = snapshotMtimes(m.workspace);
    m.pollTimer = setInterval(() => {
      const now = snapshotMtimes(m.workspace);
      for (const [rel, t] of now) {
        if (m.mtimes.get(rel) !== t) { onFsChange(m, rel); }
      }
      for (const rel of m.mtimes.keys()) if (!now.has(rel)) onFsChange(m, rel);
      m.mtimes = now;
    }, 2000);
    m.watch_mode = 'poll';
  }
}

function stopWatcher(m) {
  clearTimeout(m.debounce);
  if (m.watcher) { try { m.watcher.close(); } catch { /* 已關 */ } m.watcher = null; }
  if (m.pollTimer) { clearInterval(m.pollTimer); m.pollTimer = null; }
}
