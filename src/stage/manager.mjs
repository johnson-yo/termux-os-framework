/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/stage/manager.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { services, getServiceDef } from './catalog.mjs';
import { nodeExecutable } from '../system/node-runtime.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const STAGE_DIR = path.join(ROOT, '.runtime/stage');
const DESIRED_PATH = process.env.STAGE_DESIRED_PATH
  || (fs.existsSync('/sdcard/termux-os') ? '/sdcard/termux-os/framework/conf/stage.v1.json'
    : path.join(STAGE_DIR, 'stage.v1.json')); // 開發機無 /sdcard：落 .runtime，語義一致

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metaPath = (id) => path.join(STAGE_DIR, `${id}.json`);
const logPath = (id) => path.join(STAGE_DIR, `${id}.log`);

const readMeta = (id) => { try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; } };
const writeMeta = (id, m) => { fs.mkdirSync(STAGE_DIR, { recursive: true }); fs.writeFileSync(metaPath(id), JSON.stringify(m, null, 2)); };
const clearMeta = (id) => fs.rmSync(metaPath(id), { force: true });
const logActivity = (id) => {
  try {
    const stat = fs.statSync(logPath(id));
    return { bytes: stat.size, last_activity_at: stat.mtime.toISOString() };
  } catch { return { bytes: 0, last_activity_at: null }; }
};

// ============================================================
// PID 身份驗證 —— /proc 存在 + starttime ticks + cmdline 首段
// 三者齊全才算「仍是我們的進程」；zombie 的 cmdline 為空，自然判否
// ============================================================
const procStat = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { startTicks: rest[19], pgid: Number(rest[2]) };
  } catch { return null; }
};
const procCommand = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]; } catch { return null; }
};
const procArgs = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(1); } catch { return []; }
};
const procCwd = (pid) => {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
};
const procPackageId = (pid) => {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const entry = env.find((item) => item.startsWith('TERMUX_OS_PACKAGE_ID='));
    return entry ? entry.slice('TERMUX_OS_PACKAGE_ID='.length) : null;
  } catch { return null; }
};
const procDetails = (pid) => {
  const stat = procStat(pid);
  if (!stat) return null;
  return {
    pid: Number(pid),
    pgid: stat.pgid,
    proc_start_ticks: stat.startTicks,
    command: procCommand(pid),
    args: procArgs(pid),
    cwd: procCwd(pid),
    package_id: procPackageId(pid),
  };
};
const pidValid = (meta) => {
  if (!meta?.pid) return false;
  const current = procDetails(meta.pid);
  return !!current
    && current.proc_start_ticks === meta.proc_start_ticks
    && current.command === meta.command
    && (!meta.cwd || current.cwd === meta.cwd)
    && (!Array.isArray(meta.args) || meta.args.every((arg, index) => current.args[index] === arg));
};

const canonicalPath = (value) => {
  if (!value) return null;
  try { return fs.realpathSync(value); } catch { return path.resolve(String(value)); }
};

const commandMatches = (actual, wanted) => {
  if (!actual || !wanted) return false;
  if (actual === wanted) return true;
  const actualReal = canonicalPath(actual);
  const wantedReal = canonicalPath(wanted);
  if (actualReal && wantedReal && actualReal === wantedReal) return true;
  return path.basename(actual) === path.basename(wanted);
};

/**
 * A process is owned only when command and leading args agree, plus either the exact
 * runtime cwd or the package identity. The latter is needed during package activation:
 * an old, still-running version necessarily has a different `/versions/<version>` cwd,
 * but its injected package identity is the same service identity. Unknown processes
 * without that identity remain outside the ownership boundary.
 */
export const processMatchesService = (processInfo, def) => {
  if (!processInfo || !def) return false;
  const cwdMatches = canonicalPath(processInfo.cwd) === canonicalPath(def.cwd);
  const packageMatches = !!def.package && processInfo.package_id === def.package;
  if (!cwdMatches && !packageMatches) return false;
  if (!commandMatches(processInfo.command, def.command)) return false;
  const wantedArgs = Array.isArray(def.args) ? def.args : [];
  return wantedArgs.every((arg, index) => processInfo.args?.[index] === arg);
};

const listProcessDetails = () => {
  let entries = [];
  try { entries = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)); } catch { return []; }
  return entries.map((entry) => procDetails(Number(entry))).filter(Boolean);
};

const serviceProcesses = (def) => listProcessDetails().filter((item) => processMatchesService(item, def));

const declaredPorts = (def) => (def?.ports ?? [])
  .map((item) => ({ ...item, port: Number(item?.port) }))
  .filter((item) => Number.isInteger(item.port) && item.port > 0);

const probePort = (port, host = '127.0.0.1', timeoutMs = 250) => new Promise((resolve) => {
  const socket = net.createConnection({ host, port });
  let settled = false;
  const finish = (open, error = null) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve({ open, error });
  };
  socket.once('connect', () => finish(true));
  socket.once('error', (error) => finish(false, error?.code ?? String(error?.message ?? error)));
  socket.setTimeout(timeoutMs, () => finish(false, 'timeout'));
});

const portFacts = async (def) => {
  const facts = [];
  for (const declaration of declaredPorts(def)) {
    const result = await probePort(declaration.port);
    facts.push({ id: declaration.id ?? null, port: declaration.port, open: result.open, error: result.error });
  }
  return facts;
};

const waitPorts = async (def, wantedOpen, timeoutMs) => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let facts = await portFacts(def);
  while (Date.now() < deadline && facts.some((item) => item.open !== wantedOpen)) {
    await sleep(100);
    facts = await portFacts(def);
  }
  return { ok: facts.every((item) => item.open === wantedOpen), facts };
};

const processGroup = (pgid) => listProcessDetails().filter((item) => item.pgid === pgid);

const terminateOwnedProcess = async (def, processInfo, timeoutMs) => {
  if (!processMatchesService(processInfo, def)) {
    return { ok: false, error: 'process_identity_changed', pid: processInfo?.pid ?? null };
  }
  const members = processGroup(processInfo.pgid);
  const safeGroup = members.length > 0 && members.every((item) => processMatchesService(item, def));
  const signalTarget = safeGroup ? -processInfo.pgid : processInfo.pid;
  try { process.kill(signalTarget, 'SIGTERM'); } catch { /* It may have exited between the scan and signal. */ }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let remaining = serviceProcesses(def);
  let originalAlive = procStat(processInfo.pid)?.startTicks === processInfo.proc_start_ticks;
  while ((remaining.length > 0 || originalAlive) && Date.now() < deadline) {
    await sleep(100);
    remaining = serviceProcesses(def);
    originalAlive = procStat(processInfo.pid)?.startTicks === processInfo.proc_start_ticks;
  }
  if (remaining.length > 0 || originalAlive) {
    // Bounded escalation is still identity-scoped; an unknown process is never signalled.
    for (const item of remaining) {
      if (processMatchesService(item, def)) {
        try { process.kill(item.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    const original = procDetails(processInfo.pid);
    if (original && original.proc_start_ticks === processInfo.proc_start_ticks
      && processMatchesService(original, def)) {
      try { process.kill(original.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await sleep(150);
    remaining = serviceProcesses(def);
    originalAlive = procStat(processInfo.pid)?.startTicks === processInfo.proc_start_ticks;
  }
  return { ok: remaining.length === 0 && !originalAlive, pid: processInfo.pid, safe_group: safeGroup,
    remaining: remaining.map((item) => item.pid), original_alive: originalAlive };
};

const reconcileServiceOwnership = async (def, { extra = [] } = {}) => {
  const byPid = new Map(serviceProcesses(def).map((item) => [item.pid, item]));
  for (const item of extra) {
    if (processMatchesService(item, def)) byPid.set(item.pid, item);
  }
  const owned = [...byPid.values()];
  const reaped = [];
  for (const processInfo of owned) {
    const result = await terminateOwnedProcess(def, processInfo, def.stop_timeout_ms ?? 5000);
    reaped.push({ pid: processInfo.pid, ...result });
    if (!result.ok) return { ok: false, error: 'old_process_not_stopped', reaped };
  }
  const released = await waitPorts(def, false, def.stop_timeout_ms ?? 5000);
  if (!released.ok) {
    return { ok: false, error: 'port_conflict', conflict: { owner: 'unknown', ports: released.facts }, reaped };
  }
  return { ok: true, reaped, ports: released.facts };
};

// 進程自行退出時把事實寫回 metadata（不自動重啟，018 §6.6 刻意限制）
const attachExitRecorder = (id, child) => {
  child.on('exit', (code, signal) => {
    const meta = readMeta(id);
    if (meta?.pid !== child.pid) return; // 已被 stop 清理或已重啟
    writeMeta(id, { ...meta, exited_at: new Date().toISOString(), exit_code: code, exit_signal: signal });
  });
};

// ============================================================
// Desired State —— 只記 running|stopped 的用戶意圖；用戶 start/stop 改它，
// Framework Quiesce 保留它；不存 PID/health/runtime state（020 §12）
// ============================================================
export function readDesiredState() {
  try { return JSON.parse(fs.readFileSync(DESIRED_PATH, 'utf8')); }
  catch { return { schema: 'termux-os-framework.stage.conf.v1', services: {} }; }
}

function writeDesiredState(state) {
  fs.mkdirSync(path.dirname(DESIRED_PATH), { recursive: true });
  const tmp = DESIRED_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DESIRED_PATH);
}

export function setServiceDesiredState(id, desired) {
  const state = readDesiredState();
  state.services ??= {};
  state.services[id] = { desired };
  writeDesiredState(state);
}

export const getServiceDesired = (id) => readDesiredState().services?.[id]?.desired ?? 'stopped';

// Framework 啟動時恢復：必須在 reconcileRuntimeState 之後調用，否則 crash 後會啟第二份。
// Startup and later dependency/provider events intentionally share the same pass and guard.
export async function restoreDesiredServices() {
  return requestDesiredReconcile('startup_restore');
}

// ============================================================
// 狀態 —— 每次實時計算，Process 與 Health 嚴格分離
// ============================================================
const probeHealth = async (def, processState) => {
  if (!def.health) return { state: 'not_configured' };
  if (processState !== 'running') return { state: 'unknown' };
  const checked_at = new Date().toISOString();
  try {
    const res = await fetch(def.health.url, { signal: AbortSignal.timeout(def.health.timeout_ms ?? 1500) });
    return { state: res.ok ? 'healthy' : 'unhealthy', checked_at };
  } catch { return { state: 'unhealthy', checked_at }; }
};

export async function getServiceStatus(id) {
  const def = getServiceDef(id);
  if (!def) return null;
  const meta = readMeta(id);
  let proc;
  if (!meta) proc = { state: 'stopped' };
  else if (pidValid(meta)) proc = { state: 'running', pid: meta.pid, started_at: meta.started_at };
  else if (meta.exited_at) proc = { state: 'exited', exit_code: meta.exit_code ?? null, exit_signal: meta.exit_signal ?? null, exited_at: meta.exited_at };
  else { clearMeta(id); proc = { state: 'stopped' }; } // stale metadata：清除，絕不發 signal
  return {
    id, name: def.name, package: def.package ?? null,
    /**
     * 這個 worker 屬於哪個 App。
     *
     * ⭐ 有主人的 worker 不是一個「系統服務」——它是那個 App 的實作細節，起停歸 App
     * 自己的頁面管。服務頁列出它，等於請使用者去管一個他沒打算管的東西，
     * 而且那裡做的操作與 App 頁面上的是同一件事，只是看起來像兩件。
     * 監管照舊（重啟、健康、日誌都在），變的只是它出現在哪。
     */
    app: def.app ?? null,
    desired: getServiceDesired(id), process: proc,
    health: await probeHealth(def, proc.state), ...logActivity(id),
  };
}

export const listServices = () => Promise.all(services.map((s) => getServiceStatus(s.id)));

export async function checkServiceHealth(id) {
  const def = getServiceDef(id);
  if (!def) return null;
  return probeHealth(def, (await getServiceStatus(id)).process.state);
}

/**
 * 服務啟動門禁，由 Core 在啟動時注入（見 `src/server.mjs`）。
 *
 * ⚠ 刻意用**注入**而不是 import。`capabilities/resolver` 已經 import 本檔，
 * 而依賴解析要用到 loader 與 capability——頂層或惰性 import 都會構成
 * 「模組還沒評估完就等自己」的環，本檔自測裡的頂層 await 一撞就死鎖。
 *
 * 預設放行：Core 在沒有任何 Package 的情況下必須能起來（README 的硬性要求），
 * 而那時根本沒有依賴可查。
 */
let startGate = async () => ({ ok: true, reason: 'no_gate_installed' });

let reconcileLogger = (...args) => console.log(...args);
let reconcilePromise = null;
let reconcileDirty = false;
let reconcileReasons = [];

export function setDesiredReconcileLogger(fn) {
  reconcileLogger = typeof fn === 'function' ? fn : (...args) => console.log(...args);
}

const reconcileLog = (line) => {
  try { reconcileLogger(line); } catch { /* Logging must not affect lifecycle decisions. */ }
};

export function setServiceStartGate(fn) {
  startGate = typeof fn === 'function' ? fn : (async () => ({ ok: true, reason: 'no_gate_installed' }));
}

/**
 * One desired-state pass. A dependency refusal is a normal waiting result: startService keeps the
 * user's desired=running bit and returns the structured gate facts, while this pass does not invent
 * a timer or a second supervisor. A later state/package/service event calls requestDesiredReconcile.
 */
export async function reconcileDesiredServices({ reason = 'manual' } = {}) {
  const attempted = [];
  for (const s of [...services]) {
    if (getServiceDesired(s.id) !== 'running') continue;
    const before = await getServiceStatus(s.id);
    if (before?.process?.state === 'running') continue;

    const result = await startService(s.id);
    attempted.push({ id: s.id, ...result });
    if (result.error === 'dependencies_not_ready') {
      const blocked = (result.blocked ?? []).map((item) => `${item.kind}:${item.id}:${item.state}`).join(',');
      reconcileLog(`stage reconcile at=${new Date().toISOString()} reason=${reason} service=${s.id} desired=running action=waiting_dependencies blocked=${blocked || 'unknown'}`);
    } else if (result.ok && result.process?.state === 'running') {
      reconcileLog(`stage reconcile at=${new Date().toISOString()} reason=${reason} service=${s.id} desired=running dependencies=ready action=start`);
    } else if (!result.ok) {
      // A command/config/runtime failure is recorded once for this event. It is not converted into
      // a self-triggering restart loop; only a later actual state change can request another pass.
      reconcileLog(`stage reconcile at=${new Date().toISOString()} reason=${reason} service=${s.id} desired=running action=start_failed error=${result.error ?? 'unknown'}`);
    }
  }
  return attempted;
}

/**
 * Event-driven reconcile request with a tiny reentrancy guard. A request during a pass marks it
 * dirty; the same promise then performs one more idempotent pass after the current one finishes.
 * There is intentionally no timer, queue, interval, or backoff here.
 */
export function requestDesiredReconcile(reason = 'state_change') {
  const label = String(reason || 'state_change');
  reconcileReasons.push(label);
  if (reconcileReasons.length > 32) reconcileReasons.splice(0, reconcileReasons.length - 32);
  reconcileLog(`stage reconcile requested reason=${label}`);
  if (reconcilePromise) {
    reconcileDirty = true;
    return reconcilePromise;
  }

  reconcilePromise = (async () => {
    const all = [];
    do {
      reconcileDirty = false;
      const passReason = reconcileReasons.splice(0).join(',') || 'state_change';
      try {
        all.push(...await reconcileDesiredServices({ reason: passReason }));
      } catch (error) {
        // Keep the Framework alive if a malformed third-party service status throws. The next
        // explicit dependency/package event can request a fresh pass, but this pass is not retried.
        reconcileLog(`stage reconcile at=${new Date().toISOString()} reason=${passReason} action=error error=${String(error?.message ?? error)}`);
      }
    } while (reconcileDirty || reconcileReasons.length);
    return all;
  })().finally(() => {
    reconcilePromise = null;
    reconcileDirty = false;
    reconcileReasons = [];
  });
  return reconcilePromise;
}

// ============================================================
// 生命週期 —— start/stop 冪等；restart 固定 = stop→start
// ============================================================
export async function startService(id) {
  const def = getServiceDef(id);
  if (!def) return { ok: false, error: 'unknown_service' };
  setServiceDesiredState(id, 'running');
  const meta = readMeta(id);
  const metaProcess = pidValid(meta) ? procDetails(meta.pid) : null;
  if (metaProcess && processMatchesService(metaProcess, def)) {
    return { ok: true, changed: false, ...(await getServiceStatus(id)) };
  }
  /**
   * 依賴門禁。⚠ 放在 `pidValid` 之後：已經在跑的服務不重新過門，否則一次探針抖動
   * 就會讓「查一下狀態」變成「把它關掉」。
   */
  const gate = await startGate(def);
  if (!gate.ok) {
    clearMeta(id);
    return { ok: false, ...gate };
  }
  /**
   * Metadata is not the ownership boundary: a Framework crash can leave a
   * perfectly healthy Package process with no metadata. Reconcile only a
   * process whose cwd, command, and args prove it is this service. An open
   * listener with no such proof is an unknown conflict and is never killed.
   */
  const ownership = await reconcileServiceOwnership(def);
  if (!ownership.ok) {
    return { ok: false, ...ownership };
  }
  if (meta) clearMeta(id); // exited/stale 記錄讓位給新一輪
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const logFd = fs.openSync(logPath(id), 'a');
  const child = spawn(def.command, def.args, {
    cwd: def.cwd,
    env: { ...process.env, ...def.env },
    detached: true, // 獨立 process group（pgid = child.pid）
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  /**
   * ⚠ **一个起不来的服务不许带走控制面。**
   *
   * `spawn` 的失败是**异步**的 `error` 事件，没有监听者就是一次
   * unhandled 'error' → 整个 Framework 进程退出。真机上确实发生过：
   * 一个 cwd 不存在的 service（见 dev-runtime.mjs 的 orphan generation）
   * 让 `spawn` 报 ENOENT，Framework 随之消失，连带所有其它 package。
   * ⛔ 失败要落在这一个服务身上，⛔ 不是落在所有人身上。
   */
  child.on('error', (error) => {
    /**
     * ⚠ 写进**这个服务自己的**日志——那是有人排查它时会看的地方。
     * ⚠ 并把 ENOENT 这个最容易指错方向的错误翻译一下：cwd 不存在时，
     *   Node 报的是「找不到 command」，而 command 好端端地在那儿。
     */
    const hint = error?.code === 'ENOENT' && def.cwd && !fs.existsSync(def.cwd)
      ? ` (working directory does not exist: ${def.cwd} — the command itself is fine)` : '';
    try {
      fs.appendFileSync(logPath(id),
        `[stage] spawn failed: ${String(error?.message ?? error)}${hint}\n`);
    } catch { /* 日志写不下去不该再抛一次 */ }
    try { clearMeta(id); } catch { /* 同上 */ }
  });
  writeMeta(id, {
    service_id: id,
    pid: child.pid,
    pgid: child.pid,
    started_at: new Date().toISOString(),
    proc_start_ticks: procStat(child.pid)?.startTicks ?? '',
    command: def.command,
    args: [...(def.args ?? [])],
    cwd: def.cwd,
    package: def.package ?? null,
    ports: declaredPorts(def).map((port) => ({ id: port.id ?? null, port: port.port })),
  });
  attachExitRecorder(id, child);
  child.unref();
  await sleep(400); // 短暫確認沒有立即退出（立即退出會被 exit recorder 記成 exited）
  const result = { ok: true, changed: true, ownership, ...(await getServiceStatus(id)) };
  // A newly running provider can unblock another desired service. Only a confirmed running process
  // emits this event; spawn errors and later crashes never become an automatic restart supervisor.
  if (result.process?.state === 'running') requestDesiredReconcile(`service_ready:${id}`);
  return result;
}

export async function stopService(id, { preserveDesired = false } = {}) {
  const def = getServiceDef(id);
  if (!def) return { ok: false, error: 'unknown_service' };
  if (!preserveDesired) setServiceDesiredState(id, 'stopped'); // 用戶 Stop；Quiesce 走 preserveDesired
  const meta = readMeta(id);
  const owned = serviceProcesses(def);
  const metaProcess = pidValid(meta) ? procDetails(meta.pid) : null;
  const metaOwned = metaProcess && processMatchesService(metaProcess, def);
  if (!metaOwned && owned.length === 0) {
    return { ok: true, changed: false, ...(await getServiceStatus(id)) }; // idempotent
  }
  const stopped = await reconcileServiceOwnership(def, { extra: metaProcess ? [metaProcess] : [] });
  if (!stopped.ok) return { ok: false, ...stopped, ...(await getServiceStatus(id)) };
  clearMeta(id);
  return { ok: true, changed: true, ownership: stopped, ...(await getServiceStatus(id)) };
}

export async function restartService(id) {
  const stopped = await stopService(id, { preserveDesired: true }); // desired 保持 running
  if (!stopped.ok) return stopped;
  return startService(id);
}

// Framework Quiesce（正常關閉/deploy/rollback）默認保留 desired（020 §12.2）
export async function stopAllServices({ preserveDesired = true } = {}) {
  const results = [];
  for (const s of services) results.push({ id: s.id, ...(await stopService(s.id, { preserveDesired })) });
  return { ok: true, services: results };
}

// ============================================================
// 日誌與 reconcile
// ============================================================
export function readServiceLogs(id, lines = 100) {
  if (!getServiceDef(id)) return null;
  const n = Math.min(Math.max(1, Number(lines) || 100), 500);
  try {
    const all = fs.readFileSync(logPath(id), 'utf8').split('\n');
    if (all.at(-1) === '') all.pop();
    return all.slice(-n);
  } catch { return []; }
}

// Framework 啟動時收編/清理現場：有效 PID 重新納管（僅靠 metadata 操控），失效即清；絕不盲啟第二份
export function reconcileRuntimeState() {
  const report = { adopted: [], cleared: [] };
  let files = [];
  try { files = fs.readdirSync(STAGE_DIR).filter((f) => f.endsWith('.json')); } catch { return report; }
  for (const f of files) {
    const id = f.slice(0, -5);
    const meta = readMeta(id);
    if (getServiceDef(id) && pidValid(meta)) report.adopted.push({ id, pid: meta.pid });
    else if (meta?.exited_at && getServiceDef(id)) { /* 保留 exited 記錄供查看 */ }
    else { clearMeta(id); report.cleared.push(id); }
  }
  return report;
}

// ============================================================
// 自檢：node src/stage/manager.mjs --self-test
// ============================================================
const { fileURLToPath: selfTestUrl } = await import('node:url');
const { resolve: selfTestPath } = await import('node:path');
// ⚠ 只在**本檔被直接執行**時跑。少了 argv[1] 這半，任何 transitively import 本檔的
// 自檢都會被這一塊劫持並提前 process.exit——那個自檢的斷言一條也不會執行，
// 而輸出看起來完全正常，只是印的是別人的 PASS。
if (process.argv.includes('--self-test')
  && process.argv[1] && selfTestPath(process.argv[1]) === selfTestUrl(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const ID = 'stage.hello';
  setDesiredReconcileLogger(() => {});
  services.push({
    id: ID,
    name: 'Stage self-test fixture',
    command: nodeExecutable(),
    args: ['src/stage/fixture.mjs'],
    cwd: ROOT,
    env: { PORT: '8991' },
    health: { type: 'http', url: 'http://127.0.0.1:8991/health', timeout_ms: 1500 },
    ports: [{ id: 'http', port: 8991 }],
    stop_timeout_ms: 5000,
  });
  await stopService(ID); // 清場

  t('list service', (await listServices()).some((s) => s.id === ID && s.process.state));

  const s1 = await startService(ID);
  t('start service', s1.ok && s1.changed && s1.process.state === 'running');

  const s2 = await startService(ID);
  t('duplicate start is idempotent', s2.ok && !s2.changed && s2.process.pid === s1.process.pid);

  t('process running', (await getServiceStatus(ID)).process.state === 'running');
  await sleep(300);
  t('health healthy', (await checkServiceHealth(ID)).state === 'healthy');
  t('logs captured', readServiceLogs(ID, 50).some((l) => l.includes('started')));

  const s3 = await restartService(ID);
  t('restart changes pid', s3.ok && s3.process.state === 'running' && s3.process.pid !== s1.process.pid);

  const pid3 = s3.process.pid;
  const s4 = await stopService(ID);
  t('stop process group', s4.ok && s4.changed && s4.process.state === 'stopped' && !procStat(pid3));

  const s5 = await stopService(ID);
  t('duplicate stop is idempotent', s5.ok && !s5.changed);

  // Package activation changes the version directory. The package identity is the
  // deliberate bridge across that directory change; a foreign identity is rejected.
  const packageDef = { package: 'github.termux-os.service.stage-fixture', command: nodeExecutable(),
    args: ['src/stage/fixture.mjs'], cwd: '/tmp/new-version' };
  const oldVersionProcess = { package_id: packageDef.package, command: nodeExecutable(),
    args: ['src/stage/fixture.mjs'], cwd: '/tmp/old-version' };
  const foreignProcess = { package_id: 'github.example.foreign', command: nodeExecutable(),
    args: ['src/stage/fixture.mjs'], cwd: '/tmp/old-version' };
  t('package identity bridges version-directory activation', processMatchesService(oldVersionProcess, packageDef));
  t('foreign package identity is not adopted', !processMatchesService(foreignProcess, packageDef));

  // stale PID：無關進程 + 偽造 metadata → 不發 signal、清 metadata、無關進程存活
  const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  writeMeta(ID, { service_id: ID, pid: bystander.pid, pgid: bystander.pid, proc_start_ticks: '1', command: nodeExecutable() });
  const s6 = await stopService(ID);
  const bystanderAlive = !!procStat(bystander.pid);
  t('stale pid rejected', s6.ok && !s6.changed && bystanderAlive && !readMeta(ID));
  try { process.kill(bystander.pid, 'SIGKILL'); } catch {}

  // A Framework crash can leave the Package listener alive while its stage
  // metadata is gone. The restart path must prove identity before replacing it.
  const orphanStart = await startService(ID);
  const orphanPid = orphanStart.process?.pid;
  clearMeta(ID);
  const orphanReplaced = await startService(ID);
  t('metadata-free same-identity process is replaced before bind',
    orphanReplaced.ok && orphanReplaced.process?.state === 'running'
      && orphanReplaced.process.pid !== orphanPid
      && orphanReplaced.ownership?.reaped?.some((item) => item.pid === orphanPid)
      && !procStat(orphanPid));
  await stopService(ID);

  // An unrelated listener must remain untouched and be reported as unknown.
  const conflict = spawn(process.execPath, ['-e',
    "require('node:http').createServer((req,res)=>res.end('foreign')).listen(8991,'127.0.0.1')",
  ], { cwd: '/tmp', detached: true, stdio: 'ignore' });
  let conflictUp = false;
  for (let i = 0; i < 30 && !conflictUp; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8991/health', { signal: AbortSignal.timeout(100) });
      conflictUp = response.ok;
    } catch { await sleep(50); }
  }
  const conflictResult = await startService(ID);
  t('unknown port owner is reported and never signalled',
    conflictUp && !conflictResult.ok && conflictResult.error === 'port_conflict'
      && conflictResult.conflict?.owner === 'unknown' && procStat(conflict.pid));
  try { process.kill(-conflict.pid, 'SIGTERM'); } catch {}
  await sleep(150);

  const s7 = await startService(ID);
  process.kill(s7.process.pid, 'SIGKILL');
  await sleep(500);
  const s8 = await getServiceStatus(ID);
  t('exited process detected', s8.process.state === 'exited' && s8.process.exit_signal === 'SIGKILL' && s8.health.state === 'unknown');
  await stopService(ID); // 清場（exited 冪等）
  clearMeta(ID);

  // ---- Dependency v1：啟動門禁真的擋得住 ----------------------------------
  //
  // ⭐ 測的是**接線**，不是階梯本身（階梯在 dependencies.mjs 自測裡）。
  // 一個算得完全正確卻沒人調用的門禁，與沒有門禁一模一樣——而那種錯誤
  // 在單測全綠的情況下完全看不出來。
  setServiceStartGate(async () => ({
    ok: false, error: 'dependencies_not_ready',
    blocked: [{ kind: 'asset', id: 'model.absent', state: 'missing', blocked_by: 'not installed' }],
  }));
  const blocked = await startService(ID);
  t('an unmet dependency stops the service from starting at all',
    !blocked.ok && blocked.error === 'dependencies_not_ready' && !procStat(readMeta(ID)?.pid));
  t('the refusal names what is missing, so the UI can point somewhere',
    blocked.blocked?.[0]?.id === 'model.absent' && blocked.blocked[0].state === 'missing');
  // ⚠ 被擋下不得留下 metadata：留著會讓下一次 `getServiceStatus` 報一個並不存在的 pid。
  t('a blocked start leaves no stale metadata behind', !readMeta(ID));

  setServiceStartGate(async () => ({ ok: true, reason: 'satisfied' }));
  const allowed = await startService(ID);
  t('the same service starts once its dependency is satisfied',
    allowed.ok && allowed.process.state === 'running');
  await stopService(ID);
  clearMeta(ID);
  setServiceDesiredState(ID, 'running');
  const startupPass = await restoreDesiredServices();
  t('startup restore uses the same desired reconcile pass',
    startupPass.some((item) => item.id === ID && item.ok && item.changed)
      && (await getServiceStatus(ID)).process.state === 'running');
  await stopService(ID);
  clearMeta(ID);
  setServiceStartGate(null);
  t('clearing the gate restores the default open state',
    (await startService(ID)).ok);
  await stopService(ID);
  clearMeta(ID);

  // ---- Desired-state reconcile：dependency refusal is waiting, not a dead end --------
  let dependencyReady = false;
  let gateCalls = 0;
  setServiceStartGate(async () => {
    gateCalls += 1;
    return dependencyReady
      ? { ok: true, reason: 'satisfied' }
      : { ok: false, error: 'dependencies_not_ready', blocked: [
        { kind: 'capability', id: 'cap.late', state: 'reachable', blocked_by: 'configured but not reachable' },
      ] };
  });
  setServiceDesiredState(ID, 'running');
  const waiting = await requestDesiredReconcile('test:dependency_not_ready');
  const waitingStatus = await getServiceStatus(ID);
  t('desired running plus unmet dependency remains waiting without a process',
    waiting.some((item) => item.id === ID && item.error === 'dependencies_not_ready')
      && getServiceDesired(ID) === 'running' && waitingStatus.process.state === 'stopped');

  dependencyReady = true;
  const recovered = await requestDesiredReconcile('test:dependency_ready');
  const recoveredStatus = await getServiceStatus(ID);
  t('dependency transition reconciles and starts the service',
    recovered.some((item) => item.id === ID && item.ok && item.changed)
      && recoveredStatus.process.state === 'running');

  const startedPid = recoveredStatus.process.pid;
  const beforeDuplicate = gateCalls;
  const duplicate = await requestDesiredReconcile('test:second_dependency_ready');
  t('multiple readiness events do not start an already-running service again',
    gateCalls === beforeDuplicate && duplicate.length === 0
      && (await getServiceStatus(ID)).process.pid === startedPid);

  await stopService(ID);
  clearMeta(ID);
  const stoppedCalls = gateCalls;
  const stoppedPass = await requestDesiredReconcile('test:desired_stopped');
  t('desired stopped is never started by a dependency event',
    getServiceDesired(ID) === 'stopped' && stoppedPass.length === 0 && gateCalls === stoppedCalls);

  // Two requests while the first gate is awaiting the same dependency are coalesced. The second
  // pass is allowed to observe the now-running process, but it must not invoke the gate twice.
  let releaseGate;
  const gateRelease = new Promise((resolve) => { releaseGate = resolve; });
  gateCalls = 0;
  setServiceStartGate(async () => {
    gateCalls += 1;
    await gateRelease;
    return { ok: true, reason: 'satisfied' };
  });
  setServiceDesiredState(ID, 'running');
  const coalescedA = requestDesiredReconcile('test:coalesce:a');
  const coalescedB = requestDesiredReconcile('test:coalesce:b');
  t('reconcile requests during a pass share one in-flight promise', coalescedA === coalescedB);
  releaseGate();
  await Promise.all([coalescedA, coalescedB]);
  t('coalescing still starts exactly once', gateCalls === 1
    && (await getServiceStatus(ID)).process.state === 'running');

  await stopService(ID);
  clearMeta(ID);
  let failedStarts = 0;
  setServiceStartGate(async () => {
    failedStarts += 1;
    return { ok: false, error: 'start_failed', reason: 'fixture failure' };
  });
  setServiceDesiredState(ID, 'running');
  await requestDesiredReconcile('test:start_failed');
  await sleep(50);
  t('a real start failure does not self-retry', failedStarts === 1
    && (await getServiceStatus(ID)).process.state === 'stopped');
  await stopService(ID);
  clearMeta(ID);
  setServiceStartGate(null);

  process.exit(fails ? 1 : 0);
}
