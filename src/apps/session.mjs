/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/apps/session.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SESSION_SCHEMA = 'termux-os.app-session.v1';

let sessionRoot = null;
export const setSessionRoot = (root) => { sessionRoot = root; };
const sessionDir = () => path.join(sessionRoot ?? '.', '.runtime/app-sessions');
const sessionFile = (id) => path.join(sessionDir(), `${id}.json`);

export function resetSessions() {
  try { fs.rmSync(sessionDir(), { recursive: true, force: true }); } catch { /* 沒有就算了 */ }
}

function writeSession(s) {
  fs.mkdirSync(sessionDir(), { recursive: true });
  const tmp = `${sessionFile(s.session_id)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(tmp, sessionFile(s.session_id));
}

export function getSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return null; }
}

export function listSessions() {
  try {
    return fs.readdirSync(sessionDir()).filter((f) => f.endsWith('.json'))
      .map((f) => getSession(f.replace(/\.json$/, ''))).filter(Boolean);
  } catch { return []; }
}

/**
 * 開一個 Session（§8.2）。
 * deps 由調用方注入（Core 用真的 stage manager；fixture 注入假的）——這是純邏輯，不該綁死實現。
 *
 * 順序很講究：**先記錄現狀**，再停無關的，最後啟動要用的。
 * 記錄的是 actual（進程真實狀態），不是 desired——§8.3 要恢復的是「開始前它到底在不在跑」。
 */
export async function beginSession(appId, spec, deps) {
  const { listServices, startService, stopService } = deps;
  const required = new Set(spec?.required_services ?? []);
  const all = await listServices();

  const before = {};
  for (const s of all) before[s.id] = s.process?.state ?? 'unknown';

  const session = {
    schema: SESSION_SCHEMA,
    session_id: crypto.randomUUID(),
    app: appId,
    started_at: new Date().toISOString(),
    required_services: [...required],
    services_before: before,
    quiesced: [],          // 只記**本次真的由我們停掉**的（§8.3：只恢復自己動過的）
    started: [],
    state: 'active',
  };

  if (spec?.quiesce_unrelated_services) {
    for (const s of all) {
      if (required.has(s.id)) continue;
      if ((s.process?.state ?? '') !== 'running') continue;   // 本來就沒跑 → 不關我們的事
      // preserve_desired：停的是進程，不是用戶的意圖（§8.3 紅線）
      await stopService(s.id, { preserveDesired: true });
      session.quiesced.push(s.id);
    }
  }
  for (const id of required) {
    if (before[id] === 'running') continue;                   // 已在跑 → 不重啟（免得打斷 mic）
    await startService(id);
    session.started.push(id);
  }
  writeSession(session);
  return session;
}

/**
 * 結束 Session（§8.3）：**只恢復本次實際停掉的**。
 * 開始前 running → 恢復 running；開始前 stopped → 保持 stopped。
 * 本次啟動的、而開始前沒在跑的 Service：停回去（把現場還原成我們來之前的樣子）。
 */
export async function endSession(id, deps, { state = 'completed' } = {}) {
  const { startService, stopService } = deps;
  const s = getSession(id);
  if (!s) return null;

  const restored = [];
  for (const svc of s.quiesced) {
    if (s.services_before[svc] === 'running') {
      await startService(svc);
      restored.push(svc);
    }
  }
  const stopped = [];
  for (const svc of s.started) {
    if (s.services_before[svc] !== 'running') {
      await stopService(svc, { preserveDesired: true });
      stopped.push(svc);
    }
  }
  s.state = state;
  s.ended_at = new Date().toISOString();
  s.restored = restored;
  s.stopped_after = stopped;
  writeSession(s);
  try { fs.rmSync(sessionFile(id)); } catch { /* 已清 */ }
  return s;
}

/**
 * Framework 重啟後撿走上次沒收乾淨的 Session（§8.5）。
 * App worker 崩了、被 kill 了、framework 掛了——被 quiesce 的 Service 不能就這麼一直停著。
 */
export async function recoverStaleSessions(deps) {
  const out = [];
  for (const s of listSessions()) {
    if (s.state !== 'active') continue;
    const r = await endSession(s.session_id, deps, { state: 'recovered' });
    out.push({ session_id: s.session_id, app: s.app, restored: r?.restored ?? [] });
  }
  return out;
}

// ============================================================
// 自檢：node src/apps/session.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appsess-'));
  setSessionRoot(tmp);

  // 假 Stage：只記錄被要求做了什麼，並跟蹤 desired 有沒有被動過
  const makeStage = (initial) => {
    const state = { ...initial };
    const desired = { ...initial };   // desired 應**全程不變**
    const calls = [];
    return {
      state, desired, calls,
      deps: {
        listServices: async () => Object.entries(state).map(([id, st]) => ({ id, process: { state: st } })),
        startService: async (id) => { state[id] = 'running'; calls.push(`start:${id}`); },
        stopService: async (id, opts) => {
          state[id] = 'stopped'; calls.push(`stop:${id}${opts?.preserveDesired ? ':preserve' : ':DESIRED!'}`);
          if (!opts?.preserveDesired) desired[id] = 'stopped';   // 沒 preserve 就是改了用戶意圖
        },
      },
    };
  };
  const spec = { required_services: ['speech.asr'], quiesce_unrelated_services: true, restore_on_stop: true };

  // --- 典型場景：ASR 沒跑、翻譯在跑 ---
  let st = makeStage({ 'speech.asr': 'stopped', 'translate.hymt': 'running' });
  let s = await beginSession('hello', spec, st.deps);
  t('unrelated running service quiesced', st.state['translate.hymt'] === 'stopped' && s.quiesced.includes('translate.hymt'));
  t('required service started', st.state['speech.asr'] === 'running' && s.started.includes('speech.asr'));
  t('quiesce used preserve_desired (never touch user intent)',
    st.calls.includes('stop:translate.hymt:preserve') && !st.calls.some((c) => c.includes('DESIRED!')));
  t('session persisted while active', getSession(s.session_id)?.state === 'active');

  await endSession(s.session_id, st.deps);
  t('quiesced service restored to its pre-session state', st.state['translate.hymt'] === 'running');
  t('service we started is stopped again (it was not running before)', st.state['speech.asr'] === 'stopped');
  t('desired state untouched end-to-end',
    st.desired['translate.hymt'] === 'running' && st.desired['speech.asr'] === 'stopped');
  t('session file cleaned up after end', getSession(s.session_id) === null);

  // --- 開始前就 stopped 的，結束後必須**保持 stopped**（§8.3） ---
  st = makeStage({ 'speech.asr': 'stopped', 'translate.hymt': 'stopped' });
  s = await beginSession('hello', spec, st.deps);
  t('already-stopped unrelated service not touched', !s.quiesced.includes('translate.hymt'));
  await endSession(s.session_id, st.deps);
  t('pre-stopped service stays stopped after session', st.state['translate.hymt'] === 'stopped');

  // --- 需要的 Service 本來就在跑 → 不重啟（免得打斷 mic） ---
  st = makeStage({ 'speech.asr': 'running', 'translate.hymt': 'stopped' });
  s = await beginSession('hello', spec, st.deps);
  t('already-running required service not restarted', !st.calls.includes('start:speech.asr'));
  await endSession(s.session_id, st.deps);
  t('required service left running (it was running before)', st.state['speech.asr'] === 'running');

  // --- 崩潰恢復（§8.5）：session 檔還在，framework 重啟後撿走 ---
  st = makeStage({ 'speech.asr': 'stopped', 'translate.hymt': 'running' });
  s = await beginSession('hello', spec, st.deps);
  t('crash scenario: unrelated stopped, session file left behind',
    st.state['translate.hymt'] === 'stopped' && getSession(s.session_id).state === 'active');
  const rec = await recoverStaleSessions(st.deps);
  t('stale session recovered on framework restart', rec.length === 1 && rec[0].app === 'hello');
  t('crash recovery restores quiesced service', st.state['translate.hymt'] === 'running');
  t('recovered session file cleaned', getSession(s.session_id) === null);
  t('second recovery is a no-op', (await recoverStaleSessions(st.deps)).length === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
