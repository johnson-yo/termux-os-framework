/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/theatre/runtime.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { getScene, getScript } from './catalog.mjs';

// ============================================================
// Action Registry
// ============================================================
const actions = new Map();

/**
 * 025 §6.4：把 lease 包在 **registerAction** 而不是各個調用點。
 * Action 有兩條調用路徑（theatre runScript 與 capability invoke），包在註冊處才不會漏掉一條；
 * 也讓 Package 永遠不必自己 begin/end（§6.3：普通 Package 不該手動管 lease）。
 *
 * 027 §9：lease **惰性建立**——第一次 renew（=第一塊非靜音 PCM 真正寫向揚聲器，speak() 只在
 * 真實音頻上 renew）才 begin；TTS 合成期間 Gate 保持 inactive。合成失敗＝從未 begin＝無殘留。
 * begun 之後無論成功、拋錯，lease 一律結束；真的卡死還有 TTL 兜底（§6.4：不得永久卡住 ASR）。
 */
export function registerAction(action) {
  if (!action?.id || typeof action.run !== 'function') throw new Error(`invalid action: ${action?.id}`);
  actions.set(action.id, action);
}

export const getAction = (id) => actions.get(id);
// 029 Dev Runtime：卸載 Package 時回收其 Action（只有 loader 的 unregisterPackage 該調用）
export const unregisterAction = (id) => actions.delete(id);

const isAvailable = async (a) => {
  try { return Boolean(await a.available()); } catch { return false; }
};

export const listActions = () =>
  Promise.all([...actions.values()].map(async (a) => ({
    id: a.id, name: a.name, adapter: a.adapter, available: await isAvailable(a),
  })));

// ============================================================
// Script Runner —— 順序執行，value 鏈式傳遞，fail-fast
// ============================================================
export async function runScript(script, value) {
  // 先整體預檢：任何一步 unknown/unavailable 都拒絕開演（一步不跑）
  for (const id of script.steps) {
    const a = actions.get(id);
    if (!a) return { ok: false, error: 'unknown_action', action: id, steps: [] };
    if (!await isAvailable(a)) return { ok: false, error: 'action_unavailable', action: id, steps: [] };
  }
  const steps = [];
  for (const id of script.steps) {
    try {
      value = await actions.get(id).run(value);
      steps.push({ action: id, ok: true });
    } catch (e) {
      steps.push({ action: id, ok: false, error: String(e?.message ?? e) });
      return { ok: false, error: 'action_failed', action: id, steps, value };
    }
  }
  return { ok: true, steps, value };
}

export async function performScene(sceneId, value) {
  const scene = getScene(sceneId);
  if (!scene) return { ok: false, error: 'unknown_scene', scene: sceneId };
  const result = await runScript(getScript(scene.script), value);
  return { scene: scene.id, ...result };
}

// ============================================================
// 自檢：node src/theatre/runtime.mjs --self-test
// （必須驗證自己是入口模塊：本文件被 package loader import，不加判斷會搶跑對方的 self-test）
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { builtinActions } = await import('./adapters.mjs');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  builtinActions.forEach(registerAction);
  t('register action', getAction('debug.echo')?.adapter === 'builtin');

  registerAction({ id: 'test.upper', name: 'Upper', adapter: 'builtin',
    available: async () => true, run: async (v) => String(v).toUpperCase() });
  const seq = await runScript({ steps: ['debug.echo', 'test.upper'] }, 'Hello');
  t('run sequential script', seq.ok && seq.value === 'HELLO' && seq.steps.length === 2);

  const unknown = await runScript({ steps: ['debug.echo', 'no.such.action'] }, 'x');
  t('unknown action rejected', !unknown.ok && unknown.error === 'unknown_action' && unknown.steps.length === 0);

  registerAction({ id: 'test.boom', name: 'Boom', adapter: 'builtin',
    available: async () => true, run: async () => { throw new Error('boom'); } });
  const failed = await runScript({ steps: ['debug.echo', 'test.boom', 'debug.echo'] }, 'x');
  t('failed action stops script', !failed.ok && failed.error === 'action_failed'
    && failed.action === 'test.boom' && failed.steps.length === 2 && failed.steps[0].ok);

  const echoScene = await performScene('framework-echo', 'Hello');
  t('perform framework-echo scene', echoScene.ok && echoScene.value === 'Hello');

  const noScene = await performScene('no-such-scene', 'x');
  t('unknown scene rejected', !noScene.ok && noScene.error === 'unknown_scene');

  process.exit(fails ? 1 : 0);
}
