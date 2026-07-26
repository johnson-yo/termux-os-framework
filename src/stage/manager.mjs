/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/stage/manager.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
const pidValid = (meta) => {
  if (!meta?.pid) return false;
  const st = procStat(meta.pid);
  return !!st && st.startTicks === meta.proc_start_ticks && procCommand(meta.pid) === meta.command;
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

// Framework 啟動時恢復：必須在 reconcileRuntimeState 之後調用，否則 crash 後會啟第二份
export async function restoreDesiredServices() {
  const restored = [];
  for (const s of services) {
    if (getServiceDesired(s.id) !== 'running') continue;
    const status = await getServiceStatus(s.id);
    if (status.process.state === 'running') continue; // 已被 reconcile 收編
    restored.push({ id: s.id, ...(await startService(s.id)) });
  }
  return restored;
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
    id, name: def.name, package: def.package ?? null, desired: getServiceDesired(id), process: proc,
    health: await probeHealth(def, proc.state), ...logActivity(id),
  };
}

export const listServices = () => Promise.all(services.map((s) => getServiceStatus(s.id)));

export async function checkServiceHealth(id) {
  const def = getServiceDef(id);
  if (!def) return null;
  return probeHealth(def, (await getServiceStatus(id)).process.state);
}

// ============================================================
// 生命週期 —— start/stop 冪等；restart 固定 = stop→start
// ============================================================
export async function startService(id) {
  const def = getServiceDef(id);
  if (!def) return { ok: false, error: 'unknown_service' };
  setServiceDesiredState(id, 'running');
  const meta = readMeta(id);
  if (pidValid(meta)) return { ok: true, changed: false, ...(await getServiceStatus(id)) };
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
  writeMeta(id, {
    service_id: id,
    pid: child.pid,
    pgid: child.pid,
    started_at: new Date().toISOString(),
    proc_start_ticks: procStat(child.pid)?.startTicks ?? '',
    command: def.command,
  });
  attachExitRecorder(id, child);
  child.unref();
  await sleep(400); // 短暫確認沒有立即退出（立即退出會被 exit recorder 記成 exited）
  return { ok: true, changed: true, ...(await getServiceStatus(id)) };
}

export async function stopService(id, { preserveDesired = false } = {}) {
  const def = getServiceDef(id);
  if (!def) return { ok: false, error: 'unknown_service' };
  if (!preserveDesired) setServiceDesiredState(id, 'stopped'); // 用戶 Stop；Quiesce 走 preserveDesired
  const meta = readMeta(id);
  if (!pidValid(meta)) return { ok: true, changed: false, ...(await getServiceStatus(id)) }; // 冪等
  try { process.kill(-meta.pgid, 'SIGTERM'); } catch { /* 進程組剛消失 */ }
  const deadline = Date.now() + (def.stop_timeout_ms ?? 5000);
  while (Date.now() < deadline && pidValid(meta)) await sleep(150);
  if (pidValid(meta)) {
    try { process.kill(-meta.pgid, 'SIGKILL'); } catch { /* 同上 */ }
    await sleep(200);
  }
  clearMeta(id);
  return { ok: true, changed: true, ...(await getServiceStatus(id)) };
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
if (process.argv.includes('--self-test')) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const ID = 'stage.hello';
  services.push({
    id: ID,
    name: 'Stage self-test fixture',
    command: nodeExecutable(),
    args: ['src/stage/fixture.mjs'],
    cwd: ROOT,
    env: { PORT: '8991' },
    health: { type: 'http', url: 'http://127.0.0.1:8991/health', timeout_ms: 1500 },
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

  // stale PID：無關進程 + 偽造 metadata → 不發 signal、清 metadata、無關進程存活
  const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  writeMeta(ID, { service_id: ID, pid: bystander.pid, pgid: bystander.pid, proc_start_ticks: '1', command: nodeExecutable() });
  const s6 = await stopService(ID);
  const bystanderAlive = !!procStat(bystander.pid);
  t('stale pid rejected', s6.ok && !s6.changed && bystanderAlive && !readMeta(ID));
  try { process.kill(bystander.pid, 'SIGKILL'); } catch {}

  const s7 = await startService(ID);
  process.kill(s7.process.pid, 'SIGKILL');
  await sleep(500);
  const s8 = await getServiceStatus(ID);
  t('exited process detected', s8.process.state === 'exited' && s8.process.exit_signal === 'SIGKILL' && s8.health.state === 'unknown');
  await stopService(ID); // 清場（exited 冪等）
  clearMeta(ID);

  process.exit(fails ? 1 : 0);
}
