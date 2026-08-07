/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The installed Package tree, `loader.mjs` for in-place reload, and `git-state.mjs`
 *          for the released/edited fact.
 * [OUTPUT]: `initDevRuntime`, `devWatchStart`, `devWatchStop`, `devReload`, `devStatus`,
 *           `listDevWatchers`, `isDevWatched`, `devEvents`.
 * [POS]: src/packages/dev-runtime.mjs in termux-os-framework. A file watcher over the single
 *        installed Package, and nothing more.
 * [PROTOCOL]: This module must never answer "is this Package released or edited". That fact is
 *             read from the work tree by git-state.mjs; a watcher record that also claimed it
 *             would be a second source of truth that can be cleared while the edit survives.
 *             Watching and editing are two independent dimensions — do not merge them.
 *             Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSinglePackage, unregisterPackage, _getRecord } from './loader.mjs';
import { hashWorkspace, WORKSPACE_HASH_SKIP as SKIP } from './workspace-hash.mjs';
import { packageGitState, describeGitState } from './git-state.mjs';
import { resolveInstalledPackages } from './installed-root.mjs';
import * as stage from '../stage/manager.mjs';

export { hashWorkspace };

let CFG = null;               // { frameworkRoot, frameworkVersion, config, configPath, saveConfig, log }
const watchers = new Map();   // package id → watcher 記錄

const genRoot = () => path.join(CFG.frameworkRoot, '.runtime/dev/gen');

/** 這個包當前 active 版本的工作樹。找不到就是沒安裝。 */
function activeDir(id) {
  const { entries } = resolveInstalledPackages();
  return entries.find((e) => e.id === id)?.dir ?? null;
}

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
 * 子模塊（./service/*.mjs）URL 不變照舊命中舊快取。每次重載把工作樹拷到新目錄，
 * 所有相對 import 都落在新 URL 上 → 整棵樹都是新代碼。舊 generation 隨手刪。
 *
 * ⚠ 這是**模塊載入細節，不是第二個實例**：註冊的仍然是同一個 package id，同一個
 * service id、同一個 URL、同一份 config 與 data。副本只決定 import 從哪裡讀字節。
 */
function newGeneration(id, dir) {
  const dst = path.join(genRoot(), id, String(Date.now()));
  copyTree(dir, dst);
  return dst;
}

const publicWatcher = (w) => ({
  package_id: w.id,
  watching: true,
  version_dir: w.dir,
  watch_mode: w.watch_mode ?? null,
  started_at: w.started_at,
  seq: w.seq,
  last_reload: w.last_reload ?? null,
  last_error: w.last_error ?? null,
});

export function initDevRuntime(cfg) {
  CFG = cfg;
  // 重啟不自動恢復監看：手機開機不能意外跑進自動重載迴圈。監看是使用者的顯式動作，
  // 而且它不影響 package 的 release/dev 判定，所以不恢復也不會丟失任何事實。
  fs.rmSync(genRoot(), { recursive: true, force: true });
}

export const listDevWatchers = () => [...watchers.values()].map(publicWatcher);
export const isDevWatched = (id) => watchers.has(id);

/** 瀏覽器輪詢口：seq 變了就刷新（web 改動/重載都會 bump）。沒在監看就沒有事件。 */
export const devEvents = (id) => {
  const w = watchers.get(id);
  if (!w) return null;
  const r = _getRecord(id);
  return { seq: w.seq, status: r?.status ?? 'unknown', error: r?.error ?? null };
};

/**
 * ⭐ 兩個獨立維度，一次答清楚。
 *
 * `state` 是「這份代碼跟發布的一不一樣」——由工作樹回答，與有沒有人在監看無關。
 * `watching` 是「改了以後會不會自動重載」——與代碼改沒改無關。
 * 把它們壓成一個「dev 態」，就等於又造了一個可以被清掉而修改仍在的狀態標誌。
 */
export function devStatus(id) {
  const dir = activeDir(id);
  if (!dir) return { ok: false, error: 'not_installed', package_id: id };
  const git = packageGitState(dir);
  const w = watchers.get(id);
  const record = _getRecord(id);
  return {
    ok: true,
    package_id: id,
    version_dir: dir,
    state: git.state,
    state_reason: git.reason,
    state_summary: describeGitState(git),
    changes: git.changes,
    ignored_paths: git.ignored,
    watching: Boolean(w),
    watch_mode: w?.watch_mode ?? null,
    seq: w?.seq ?? 0,
    last_reload: w?.last_reload ?? null,
    services: record?.registered?.services ?? [],
    status: record?.status ?? 'unknown',
    error: record?.error ?? null,
  };
}

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

/** 開始監看這個包的 active 工作樹。⚠ 它不改變、也不表示 package 的 Git 狀態。 */
export async function devWatchStart(id) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized' };
  const dir = activeDir(id);
  if (!dir) {
    return { ok: false, error: 'not_installed',
      fix: `Install ${id} first; dev now watches the installed Package, not a separate workspace.` };
  }
  if (watchers.has(id)) return { ok: true, already: true, watcher: publicWatcher(watchers.get(id)) };
  const w = {
    id, dir, started_at: new Date().toISOString(),
    source_hash: hashWorkspace(dir), seq: 1, last_error: null, last_reload: null,
  };
  watchers.set(id, w);
  startWatcher(w);
  CFG.log(`dev watch ${id}: ${dir} (${w.watch_mode})`);
  return { ok: true, watcher: publicWatcher(w), state: devStatus(id) };
}

/** 停止監看。⚠ package 的 release/dev 狀態不受影響——改過就是改過。 */
export function devWatchStop(id) {
  const w = watchers.get(id);
  if (!w) return { ok: false, error: 'not_watching' };
  stopWatcher(w);
  watchers.delete(id);
  CFG?.log(`dev watch stopped ${id}`);
  return { ok: true, package_id: id, state: devStatus(id) };
}

/** 就地重載唯一那份 instance。不建立、也不需要第二個 package。 */
export async function devReload(id, { reason = 'manual' } = {}) {
  if (!CFG) return { ok: false, error: 'dev_runtime_not_initialized' };
  const dir = activeDir(id);
  if (!dir) return { ok: false, error: 'not_installed' };
  const w = watchers.get(id);
  const wasRunning = await stopPackageServices(id);
  await unregisterPackage(id);
  const gen = newGeneration(id, dir);
  const record = await loadSinglePackage(
    // ⚠ 沒有 workspaceSlug、沒有 persistRoot 覆寫：同一個 id、同一份 config 與 data。
    { dir: gen, expectId: id, source: 'installed', cacheBust: true }, CFG);
  if (w?.gen) fs.rmSync(w.gen, { recursive: true, force: true });
  if (w) {
    w.gen = gen;
    w.source_hash = hashWorkspace(dir);
    w.seq += 1;
    w.last_error = record?.error ?? null;
    w.last_reload = new Date().toISOString();
  } else {
    fs.rmSync(gen, { recursive: true, force: true, maxRetries: 0 });
  }
  if (record?.status === 'loaded') {
    // web 資源直讀工作樹，改了立刻可見；backend 跑 generation 副本。
    record.webRoot = path.join(dir, path.dirname(record.manifest.entrypoints.webui));
    for (const sid of wasRunning) {
      if (record.registered.services.includes(sid)) await stage.startService(sid);
    }
  }
  CFG.log(`dev reload ${id} (${reason}): ${record?.status ?? 'failed'}${record?.error ? ` — ${record.error}` : ''}`);
  return { ok: record?.status === 'loaded', status: record?.status ?? 'failed', error: record?.error ?? null };
}

// ============================================================
// Watcher：優先 fs.watch，失敗回退 mtime polling；web/ 改動只 bump seq，
// backend 改動 debounce 後整包重載。watcher 失靈時 dev reload 是正式 fallback。
// ============================================================
function classifyChange(w, relPath) {
  if (!relPath) return 'backend'; // 事件沒帶路徑就保守整包重載
  const top = relPath.split(path.sep)[0];
  if (SKIP.has(top)) return null;
  // `.git` 自己的內部寫入不是代碼改動——commit 一次會產生幾十個事件。
  if (top === '.git') return null;
  const r = _getRecord(w.id);
  const webDir = r?.manifest ? path.dirname(r.manifest.entrypoints.webui) : 'web';
  return relPath.startsWith(`${webDir}${path.sep}`) || relPath.startsWith(`${webDir}/`) ? 'web' : 'backend';
}

function onFsChange(w, relPath) {
  const kind = classifyChange(w, relPath);
  if (!kind) return;
  if (kind === 'web') { w.seq += 1; return; }
  clearTimeout(w.debounce);
  w.debounce = setTimeout(() => { devReload(w.id, { reason: `file change: ${relPath}` }); }, 600);
}

function snapshotMtimes(dir) {
  const map = new Map();
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) { try { map.set(r, fs.statSync(path.join(d, e.name)).mtimeMs); } catch { /* 中途被刪 */ } }
    }
  };
  walk(dir, '');
  return map;
}

function startWatcher(w) {
  try {
    // TERMUX_OS_DEV_POLL=1 強制走 polling（共享存儲上 fs.watch 假活比不活更糟——事件靜默丟失）
    if (process.env.TERMUX_OS_DEV_POLL === '1') throw new Error('forced polling');
    w.watcher = fs.watch(w.dir, { recursive: true }, (_ev, fname) => onFsChange(w, fname ?? null));
    w.watch_mode = 'fs-watch';
  } catch {
    // Android/共享存儲上 fs.watch 不可靠——低頻 mtime polling 回退
    w.mtimes = snapshotMtimes(w.dir);
    w.pollTimer = setInterval(() => {
      const now = snapshotMtimes(w.dir);
      for (const [rel, t] of now) {
        if (w.mtimes.get(rel) !== t) { onFsChange(w, rel); }
      }
      for (const rel of w.mtimes.keys()) if (!now.has(rel)) onFsChange(w, rel);
      w.mtimes = now;
    }, 2000);
    w.watch_mode = 'poll';
  }
}

function stopWatcher(w) {
  clearTimeout(w.debounce);
  if (w.watcher) { try { w.watcher.close(); } catch { /* 已關 */ } w.watcher = null; }
  if (w.pollTimer) { clearInterval(w.pollTimer); w.pollTimer = null; }
  if (w.gen) { fs.rmSync(w.gen, { recursive: true, force: true }); w.gen = null; }
}
