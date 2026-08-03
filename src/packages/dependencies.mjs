/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A validated Manifest plus injected probes that report what is actually on this device.
 * [OUTPUT]: `DEP_STATE`, `declaredDependencies`, `resolveDependencies`, `installOrder`.
 * [POS]: src/packages/dependencies.mjs in termux-os-framework. Dependency v1 — the resolver behind
 *        install preflight, the service start gate, doctor, and the admin install modal. It answers
 *        one question per dependency: how far along the ladder did this actually get.
 * [PROTOCOL]: Deliberately not a SAT/semver solver. It resolves exactly the shapes a Manifest can
 *             declare, in topological order, and reports the first rung each dependency failed to
 *             reach. Probes are injected so the ladder is testable without a device.
 *             Keep this English header synchronized with behavior and public contracts.
 */

import { satisfies } from './version.mjs';

/**
 * ⭐ 依賴狀態是**一道階梯，不是一組獨立的旗標**。
 *
 * 每個依賴報告它爬到的最高一級，外加是哪一級卡住的。這正是任務要修的東西：
 * 「Adapter 不能只因目錄存在就視為 ready」——`installed` 與 `ready` 之間隔著
 * 配置、可達、健康、版本四級，把它們壓成一個布林，就等於宣稱裝上了就是能用。
 */
export const DEP_STATE = Object.freeze({
  MISSING: 'missing',
  INSTALLED: 'installed',
  CONFIGURED: 'configured',
  REACHABLE: 'reachable',
  HEALTHY: 'healthy',
  COMPATIBLE: 'compatible',
  READY: 'ready',
});

/** 階梯順序。`indexOf` 就是「爬了多高」，於是比較兩個狀態不需要任何分支。 */
export const DEP_LADDER = Object.freeze([
  DEP_STATE.MISSING,
  DEP_STATE.INSTALLED,
  DEP_STATE.CONFIGURED,
  DEP_STATE.REACHABLE,
  DEP_STATE.HEALTHY,
  DEP_STATE.COMPATIBLE,
  DEP_STATE.READY,
]);

export const DEP_KIND = Object.freeze({
  PACKAGE: 'package',
  CAPABILITY: 'capability',
  ASSET: 'asset',
});

const str = (value) => String(value ?? '').trim();

/**
 * Manifest → 一張扁平的依賴清單。
 *
 * ⭐ 全部復用既有欄位（023/024/025 就已經在用）：
 *   - `packages.requires[]`   Package 依賴 + 版本約束   ← 本輪唯一新增的欄位
 *   - `integrations.requires[]` Capability／Adapter 依賴
 *   - `assets.requires[]`     Asset 依賴
 * 不另建平行 schema：同一件事有兩個宣告處，遲早會有一處被忘記維護。
 */
export function declaredDependencies(manifest) {
  const nodes = [];
  for (const item of manifest?.packages?.requires ?? []) {
    nodes.push({
      kind: DEP_KIND.PACKAGE,
      id: str(item?.id),
      version: item?.version ?? null,
      required: item?.required !== false,
    });
  }
  for (const item of manifest?.integrations?.requires ?? []) {
    nodes.push({
      kind: DEP_KIND.CAPABILITY,
      id: str(item?.capability),
      version: item?.version ?? null,
      required: item?.required !== false,
      degraded_behavior: item?.degraded_behavior ?? null,
    });
  }
  for (const item of manifest?.assets?.requires ?? []) {
    nodes.push({
      kind: DEP_KIND.ASSET,
      id: str(item?.id),
      version: item?.version ?? null,
      required: item?.required !== false,
      target: item?.target ?? null,
    });
  }
  return nodes.filter((node) => node.id);
}

/**
 * 一級一級往上爬，第一個不成立的就是答案。
 *
 * `facts` 是探針交回來的事實；缺一個欄位就是「爬不到那一級」，
 * ⚠ 而不是「那一級不適用」——不適用的級別由探針明確報 `true` 跳過，
 * 沉默一律當作沒到達。缺省寬鬆會讓一個什麼都沒探到的探針把所有依賴報成 ready。
 */
function climb(facts, { version, constraint }) {
  if (!facts?.installed) return { state: DEP_STATE.MISSING, blocked_by: 'not installed' };
  if (!facts.configured) return { state: DEP_STATE.INSTALLED, blocked_by: 'installed but not configured' };
  if (!facts.reachable) return { state: DEP_STATE.CONFIGURED, blocked_by: 'configured but not reachable' };
  if (!facts.healthy) return { state: DEP_STATE.REACHABLE, blocked_by: 'reachable but not healthy' };
  const ok = satisfies(version, constraint);
  if (ok === null) {
    return {
      state: DEP_STATE.HEALTHY,
      // 「約束看不懂」與「版本不夠」是兩件事：前者要改 Manifest，後者要裝新版。
      blocked_by: `cannot compare version ${version ?? '(unknown)'} against ${constraint}`,
    };
  }
  if (!ok) return { state: DEP_STATE.HEALTHY, blocked_by: `version ${version ?? '(unknown)'} does not satisfy ${constraint}` };
  if (facts.target_ok === false) {
    return { state: DEP_STATE.COMPATIBLE, blocked_by: facts.target_reason ?? 'device target does not match' };
  }
  return { state: DEP_STATE.READY, blocked_by: null };
}

/**
 * 解析一個 Manifest 的直接依賴。
 *
 * @param probes `{ package, capability, asset }`，各自 `(id) => facts | null`。
 *        注入而非內建，因為這道階梯必須能在沒有設備的地方測——而它恰恰是
 *        「裝上了就當能用」這類錯誤唯一會現形的地方。
 */
export function resolveDependencies(manifest, probes = {}) {
  const declared = declaredDependencies(manifest);
  const nodes = declared.map((node) => {
    const probe = probes[node.kind];
    const facts = typeof probe === 'function' ? (probe(node.id, node) ?? null) : null;
    const climbed = climb(facts, { version: facts?.version ?? null, constraint: node.version });
    return {
      ...node,
      ...climbed,
      provider_id: facts?.provider_id ?? null,
      installed_version: facts?.version ?? null,
      download: facts?.download ?? null,
    };
  });
  const unmet = nodes.filter((n) => n.state !== DEP_STATE.READY);
  return {
    nodes,
    ready: unmet.every((n) => !n.required),
    missing: nodes.filter((n) => n.state === DEP_STATE.MISSING),
    blocked: unmet.filter((n) => n.required),
    degraded: unmet.filter((n) => !n.required),
  };
}

/**
 * 拓撲安裝順序：被依賴的先裝。
 *
 * @param edges `(id) => string[]`，回傳該 Package 直接依賴的 Package id。
 * @returns `{ ok, order, cycle }`。⚠ 環必須明確報出**環本身**而不只是 `ok:false`——
 *          「有環」對使用者是句廢話，他要知道是哪幾個包咬在一起。
 */
export function installOrder(rootId, edges) {
  const order = [];
  const done = new Set();
  const stack = [];
  const onStack = new Set();
  let cycle = null;

  const visit = (id) => {
    if (cycle || done.has(id)) return;
    if (onStack.has(id)) {
      // 從堆疊裡把環那一段原樣切出來，首尾同一個節點以便閱讀。
      cycle = [...stack.slice(stack.indexOf(id)), id];
      return;
    }
    onStack.add(id);
    stack.push(id);
    for (const next of edges(id) ?? []) {
      visit(next);
      if (cycle) break;
    }
    stack.pop();
    onStack.delete(id);
    if (cycle) return;
    done.add(id);
    order.push(id);
  };

  visit(rootId);
  if (cycle) return { ok: false, order: [], cycle };
  // root 自己排在最後：它的依賴必須先就位。
  return { ok: true, order, cycle: null };
}

/** 兩個狀態誰更靠前。用來把一組依賴壓成「整體卡在哪一級」。 */
export function lowestState(states) {
  let lowest = DEP_STATE.READY;
  for (const state of states) {
    if (DEP_LADDER.indexOf(state) < DEP_LADDER.indexOf(lowest)) lowest = state;
  }
  return lowest;
}

// ============================================================
// 自檢：node src/packages/dependencies.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve: resolvePath } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails += 1; };

  const ready = { installed: true, configured: true, reachable: true, healthy: true, version: '1.2.0' };
  const state = (facts, constraint) => resolveDependencies(
    { integrations: { requires: [{ capability: 'x.y', required: true, version: constraint }] } },
    { capability: () => facts },
  ).nodes[0];

  // --- 階梯：每一級都要能單獨卡住 ---
  t('no dependencies at all resolves ready',
    resolveDependencies({}, {}).ready === true && resolveDependencies({}, {}).nodes.length === 0);
  t('an unprobed dependency is missing, never ready',
    state(null).state === DEP_STATE.MISSING);
  t('installed but not configured stops at installed',
    state({ installed: true }).state === DEP_STATE.INSTALLED);
  t('configured but unreachable stops at configured',
    state({ installed: true, configured: true }).state === DEP_STATE.CONFIGURED);
  t('reachable but unhealthy stops at reachable',
    state({ installed: true, configured: true, reachable: true }).state === DEP_STATE.REACHABLE);
  t('healthy but too old stops at healthy',
    state({ ...ready, version: '1.0.0' }, '>=1.2.0').state === DEP_STATE.HEALTHY);
  t('healthy and new enough is ready', state(ready, '>=1.2.0').state === DEP_STATE.READY);
  t('an exact pin rejects a newer version',
    state(ready, '=1.0.0').state === DEP_STATE.HEALTHY && state(ready, '=1.2.0').state === DEP_STATE.READY);
  t('a mismatched device target stops at compatible',
    state({ ...ready, target_ok: false, target_reason: 'v79 != v73' }).state === DEP_STATE.COMPATIBLE);

  // ⭐ 本輪要修的正是這一條：目錄在 ≠ 能用。
  t('installed is not ready — that is the whole point of the ladder',
    DEP_LADDER.indexOf(DEP_STATE.INSTALLED) < DEP_LADDER.indexOf(DEP_STATE.READY));

  // ⚠ 「約束看不懂」不能靜默通過，也不能偽裝成「版本不夠」。
  const broken = state(ready, '^1.0.0');
  t('an unparseable constraint blocks and says so, instead of silently passing',
    broken.state === DEP_STATE.HEALTHY && /cannot compare/.test(broken.blocked_by));

  // --- required / optional ---
  const mixed = resolveDependencies({
    integrations: { requires: [
      { capability: 'need.this', required: true },
      { capability: 'nice.to.have', required: false, degraded_behavior: 'no captions' },
    ] },
  }, { capability: (id) => (id === 'need.this' ? ready : null) });
  t('a missing optional dependency does not block start',
    mixed.ready === true && mixed.degraded.length === 1 && mixed.blocked.length === 0);
  const blockedRun = resolveDependencies({
    integrations: { requires: [{ capability: 'need.this', required: true }] },
  }, { capability: () => null });
  t('a missing required dependency blocks start and is listed',
    blockedRun.ready === false && blockedRun.blocked.length === 1 && blockedRun.missing.length === 1);

  // --- 三種依賴都從既有欄位讀出來 ---
  const all = declaredDependencies({
    packages: { requires: [{ id: 'a.b.c.d', version: '>=1.0.0' }] },
    integrations: { requires: [{ capability: 'x.y', required: true }] },
    assets: { requires: [{ id: 'model.z', required: false }] },
  });
  t('package, capability and asset dependencies all come from existing fields',
    all.length === 3
    && all.filter((n) => n.kind === DEP_KIND.PACKAGE).length === 1
    && all.filter((n) => n.kind === DEP_KIND.CAPABILITY).length === 1
    && all.filter((n) => n.kind === DEP_KIND.ASSET).length === 1);
  t('required defaults to true, so forgetting the flag fails closed',
    declaredDependencies({ packages: { requires: [{ id: 'a.b.c.d' }] } })[0].required === true);

  // --- 拓撲順序與環 ---
  const graph = { root: ['a', 'b'], a: ['c'], b: ['c'], c: [] };
  const order = installOrder('root', (id) => graph[id] ?? []);
  t('dependencies install before the package that needs them',
    order.ok
    && order.order.at(-1) === 'root'
    && order.order.indexOf('c') < order.order.indexOf('a')
    && order.order.indexOf('a') < order.order.indexOf('root'));
  t('a shared dependency is installed once, not twice',
    order.order.filter((id) => id === 'c').length === 1);
  const cyclic = { root: ['a'], a: ['b'], b: ['a'] };
  const cycled = installOrder('root', (id) => cyclic[id] ?? []);
  // ⚠ 「有環」對使用者是句廢話——必須說出是哪幾個包咬在一起。
  t('a cycle is refused and names the packages caught in it',
    !cycled.ok && cycled.cycle.join('→') === 'a→b→a');

  t('lowestState reports the rung the whole set is stuck on',
    lowestState([DEP_STATE.READY, DEP_STATE.CONFIGURED, DEP_STATE.HEALTHY]) === DEP_STATE.CONFIGURED
    && lowestState([DEP_STATE.READY]) === DEP_STATE.READY);

  process.exit(fails ? 1 : 0);
}
