/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/observation.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

export const OBSERVATIONS_SCHEMA = 'termux-os.observations.v1';
const MAX_SLICE = 131072;   // 單次最多回 128KB——落後太多就跳過中間段並如實回報 skipped
const KEEP = 50;            // 會話記錄只留最近 50 條

let root = null;
let serviceIds = () => [];

export const setObservationRoot = (r) => { root = r; };
export const setObservationServices = (fn) => { serviceIds = fn; };

// component 白名單：framework 本體 + Stage 管的每個 Service。日誌路徑由白名單推導，不接受任意路徑
const logFile = (c) => (c === 'framework'
  ? path.join(root ?? '.', 'framework.log')
  : path.join(root ?? '.', '.runtime/stage', `${c}.log`));
const isComponent = (c) => c === 'framework' || serviceIds().includes(c);
// mtime 一併回報：安靜的組件（如 speech.asr 平時只記生命週期事件）要讓用戶看見
// 「多久沒寫了」，而不是讓空視圖看起來像故障
const logStat = (c) => {
  try { const s = fs.statSync(logFile(c)); return { size: s.size, mtime_ms: Math.round(s.mtimeMs) }; }
  catch { return { size: 0, mtime_ms: null }; }
};
const logSize = (c) => logStat(c).size;

export const listLogComponents = () => ['framework', ...serviceIds()]
  .map((id) => ({ id, ...logStat(id) }));

/** 讀 [after, size) 的日誌位元組。size 縮小（輪換/清空）時從頭重讀並標記 reset——不假裝連續 */
export function readLogSlice(component, after = 0) {
  if (!isComponent(component)) return null;
  const { size, mtime_ms } = logStat(component);
  let start = Math.max(0, Number(after) || 0);
  const reset = start > size;
  if (reset) start = 0;
  const skipped = Math.max(0, size - start - MAX_SLICE);
  start += skipped;
  let content = '';
  if (size > start) {
    const fd = fs.openSync(logFile(component), 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  }
  return { component, size, mtime_ms, content, skipped, reset };
}

const obsPath = () => path.join(root ?? '.', '.runtime/observations/observations.v1.json');

function readObservations() {
  try {
    const r = JSON.parse(fs.readFileSync(obsPath(), 'utf8'));
    return r?.schema === OBSERVATIONS_SCHEMA ? (r.observations ?? []) : [];
  } catch { return []; }
}

/** 觀察會話 = 「從此刻的 log offset 起算」的錨點（027 §3）。只追加記錄，日誌本體一個位元組不動 */
export function startObservation(component) {
  if (!isComponent(component)) return { ok: false, error: 'unknown_component' };
  const rec = {
    observation_id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    component,
    started_at: new Date().toISOString(),
    start_offset: logSize(component),
  };
  const p = obsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const observations = [rec, ...readObservations()].slice(0, KEEP);
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: OBSERVATIONS_SCHEMA, observations }, null, 2)}\n`);
  fs.renameSync(tmp, p);
  return { ok: true, observation: rec };
}

// ============================================================
// 自檢：node src/system/observation.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
  setObservationRoot(tmp);
  setObservationServices(() => ['speech.asr']);
  fs.writeFileSync(path.join(tmp, 'framework.log'), 'old-line-1\nold-line-2\n');

  t('component 清單 = framework + services', listLogComponents().map((c) => c.id).join(',') === 'framework,speech.asr');
  t('未知 component 讀日誌 → null（白名單外不給路徑）', readLogSlice('../etc/passwd') === null);
  t('未知 component 開會話被拒', startObservation('nope').ok === false);
  const missing = readLogSlice('speech.asr', 0);
  t('日誌不存在的 service size=0 不崩、mtime=null 不編造', missing.size === 0 && missing.mtime_ms === null);

  const s0 = readLogSlice('framework', 0);
  t('從 0 讀到全部歷史', s0.content === 'old-line-1\nold-line-2\n' && s0.size === 22);
  t('切片帶 mtime_ms（安靜組件要能看出多久沒寫）', typeof s0.mtime_ms === 'number' && s0.mtime_ms > 0);

  const obs = startObservation('framework');
  t('會話帶四要素（id/component/started_at/start_offset）',
    obs.ok && obs.observation.observation_id.startsWith('obs-')
    && obs.observation.component === 'framework'
    && !!obs.observation.started_at && obs.observation.start_offset === 22);
  t('會話落盤可讀', readObservations()[0].observation_id === obs.observation.observation_id);

  // Clear View 的本質：只推進視圖 offset。新寫入的內容從 offset 之後可讀，舊內容原封不動
  fs.appendFileSync(path.join(tmp, 'framework.log'), 'new-line\n');
  const s1 = readLogSlice('framework', obs.observation.start_offset);
  t('offset 之後只見新日誌', s1.content === 'new-line\n' && !s1.reset);
  t('歷史日誌一個位元組沒少', readLogSlice('framework', 0).content.startsWith('old-line-1'));

  // 日誌被輪換/清空：offset 超過現有 size → 從頭重讀並如實標 reset
  fs.writeFileSync(path.join(tmp, 'framework.log'), 'fresh\n');
  const s2 = readLogSlice('framework', 999);
  t('log 縮小時 reset=true 從頭讀', s2.reset && s2.content === 'fresh\n');

  // 落後超過單次上限：跳過中間段並回報 skipped，不無限膨脹響應
  fs.writeFileSync(path.join(tmp, 'framework.log'), 'x'.repeat(MAX_SLICE + 100));
  const s3 = readLogSlice('framework', 0);
  t('超窗只回尾部 + skipped 如實', s3.skipped === 100 && s3.content.length === MAX_SLICE);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
