/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The live package loader, capability resolver, and asset registry.
 * [OUTPUT]: `deviceProbes`, `resolvePackageDependencies`, `dependencyTree`.
 * [POS]: src/packages/dependency-runtime.mjs in termux-os-framework. The adapter between the pure
 *        ladder in `dependencies.mjs` and what is actually installed on this device.
 * [PROTOCOL]: Every probe reports facts only. It never decides whether a dependency is acceptable —
 *             that judgement lives in one place, and duplicating it here is how two callers start
 *             disagreeing about whether the same package is ready.
 *             Keep this English header synchronized with behavior and public contracts.
 */

import { getPackage, listPackages } from './loader.mjs';
import { describeCapability } from '../capabilities/resolver.mjs';
import { describeAsset } from '../assets/runtime.mjs';
import {
  DEP_KIND, DEP_STATE, declaredDependencies, installOrder, installPlan, resolveDependencies,
} from './dependencies.mjs';

/**
 * Capability 探針。
 *
 * ⭐ `describeCapability` 本來就把失敗分得很細（沒有提供方／有多家但沒綁定／服務沒跑／
 * action 不可用），這裡只是把那些既有分支放到階梯的對應級上——**不重新判斷一次**。
 * 重判會讓同一個 Capability 在兩個地方得出兩種 ready。
 */
async function capabilityFacts(capId) {
  const described = await describeCapability(capId);
  if (described.error === 'no_provider') return { installed: false };
  // 有提供方但沒綁定 = 裝了沒配；綁到一個不存在的提供方同理，都是「配置沒指對」。
  if (described.error === 'no_binding' || described.error === 'bound_provider_not_registered') {
    return { installed: true, configured: false, provider_id: described.providers?.[0] ?? null };
  }
  const providerPackage = described.package ? getPackage(described.package) : null;
  const base = {
    installed: true,
    configured: true,
    provider_id: described.provider ?? null,
    version: providerPackage?.manifest?.version ?? null,
  };
  if (!described.ok) return { ...base, reachable: false, reason: described.reason ?? null };
  // Package 沒 loaded、或服務沒跑，都是「配置指對了但這條路現在不通」。
  if (described.ready !== true) {
    const unreachable = /is not loaded|is failed|service .* is |package .* is /.test(String(described.reason ?? ''));
    return unreachable
      ? { ...base, reachable: false, reason: described.reason }
      : { ...base, reachable: true, healthy: false, reason: described.reason };
  }
  return { ...base, reachable: true, healthy: true };
}

/**
 * Package 探針。
 *
 * ⚠ `failed` 明確停在 `installed`：檔案在盤上，但這個包這一輪沒起來。
 * 把它算成 ready 正是本輪要修的那類錯誤——目錄在不等於能用。
 */
function packageFacts(packageId) {
  const record = getPackage(packageId);
  if (!record) return { installed: false };
  const version = record.manifest?.version ?? null;
  if (record.status !== 'loaded') {
    return { installed: true, configured: false, version, reason: record.error ?? record.status };
  }
  return { installed: true, configured: true, reachable: true, healthy: true, version };
}

/**
 * Asset 探針。⚠ 只做**不驗 sha** 的那一檔（`verify:false`）：479MB 的 ctx 算一次要數秒，
 * 而這道階梯會被 doctor、啟動門禁與安裝預檢反覆調用。真正的逐位元組復驗歸安裝路徑。
 */
function assetFacts(assetId) {
  const described = describeAsset(assetId, { verify: false });
  if (!described || described.reason?.startsWith?.('missing_asset')) {
    return { installed: false, reason: described?.detail ?? 'not registered' };
  }
  const base = {
    installed: true,
    configured: true,
    reachable: true,
    version: described.version ?? null,
    provider_id: described.package ?? null,
  };
  if (described.reason?.startsWith?.('target_mismatch')) {
    return { ...base, healthy: true, target_ok: false, target_reason: described.detail ?? 'device target does not match' };
  }
  if (described.ready !== true) return { ...base, healthy: false, reason: described.detail ?? described.reason ?? null };
  return { ...base, healthy: true, target_ok: true };
}

/**
 * 給解析器用的一組活探針。
 *
 * ⚠ Capability 探針是 async 而階梯是同步的，所以這裡**先把事實抓齊再進階梯**：
 * 讓階梯保持純同步是它能被單測驅動的全部理由。
 */
export async function deviceProbes(manifest) {
  const declared = declaredDependencies(manifest);
  const capabilityCache = new Map();
  for (const node of declared) {
    if (node.kind !== DEP_KIND.CAPABILITY || capabilityCache.has(node.id)) continue;
    capabilityCache.set(node.id, await capabilityFacts(node.id));
  }
  return {
    [DEP_KIND.PACKAGE]: (id) => packageFacts(id),
    [DEP_KIND.CAPABILITY]: (id) => capabilityCache.get(id) ?? null,
    [DEP_KIND.ASSET]: (id) => assetFacts(id),
  };
}

/** 一個 Manifest 在**這台機器上**的依賴解析。 */
export async function resolvePackageDependencies(manifest) {
  return resolveDependencies(manifest, await deviceProbes(manifest));
}

/**
 * 整棵依賴樹 + 拓撲安裝順序。
 *
 * @param manifestFor `(packageId) => manifest | null`，用來走 Package 依賴的下一層。
 *        取不到 Manifest 的節點視為葉子——它會在自己那一格如實報 `missing`，
 *        而不是讓整棵樹解析失敗。
 */
export async function dependencyTree(rootManifest, manifestFor = () => null) {
  const rootId = rootManifest?.id ?? '(root)';
  const manifests = new Map([[rootId, rootManifest]]);
  const edgesOf = (id) => {
    const manifest = manifests.has(id) ? manifests.get(id) : manifestFor(id);
    if (!manifests.has(id)) manifests.set(id, manifest);
    if (!manifest) return [];
    return declaredDependencies(manifest)
      .filter((node) => node.kind === DEP_KIND.PACKAGE)
      .map((node) => node.id);
  };
  const order = installOrder(rootId, edgesOf);
  const resolved = await resolvePackageDependencies(rootManifest);
  return {
    root: rootId,
    ...resolved,
    order: order.ok ? order.order.filter((id) => id !== rootId) : [],
    cycle: order.cycle,
    ok: order.ok && resolved.ready,
  };
}

/**
 * 安裝預檢：把 preflight 交出來的**聲明**在這台設備上解析。
 *
 * ⭐ 聲明來自打包子進程（它認識這個歸檔），狀態只有這裡知道（Capability 註冊表
 * 活在本進程記憶體裡）。兩邊各答自己真的知道的那一半。
 *
 * ⚠ Capability 在預檢時**刻意不探**：安裝前提供方多半還沒起來，探它只會得到一個
 * 誠實但無用的 missing。它歸啟動門禁管，那時候答案才有意義。
 */
export function resolveDeclaredDependencies(declared, {
  catalog = () => null,
  providers = () => [],
} = {}) {
  const plan = installPlan(declared, {
    catalog,
    probes: {
      [DEP_KIND.PACKAGE]: (id) => packageFacts(id),
      [DEP_KIND.ASSET]: (id) => assetFacts(id),
      [DEP_KIND.CAPABILITY]: () => null,
    },
  });

  /**
   * ⭐ 把「缺一個能力」翻成「裝這個包就行」。
   *
   * 一個 Capability 依賴聲明的是一種**能力**，不是一個包——這是刻意的，消費方
   * 不該寫死誰提供它。代價是解析到此為止：`no provider registered` 是誠實的，
   * 但它不可行動，因為沒有任何地方記得誰供應這個能力。Registry 索引補上了那一步。
   *
   * ⚠ 有多個提供方時**不替使用者選**。把候選都列出來，讓確認表去問——
   * 隨手挑第一個會讓「裝上了但不是我要的那個」變成一種安靜的失敗。
   */
  const supply = [];
  for (const node of plan.nodes ?? []) {
    if (node.state !== DEP_STATE.MISSING) continue;
    /**
     * ⛔ 一個**必需**的 Package 依賴，坐標已經在節點上了，也要一起裝。
     *
     * 先前這個迴圈只認 Capability，於是三個帶著完整下載坐標的 Package 依賴
     * 被整整跳過：安裝「成功」，裝出來的包卻缺著它宣告過的必需依賴。
     * 計畫算得出來、卻不照著做，比算不出来更難查——前者每一步看起來都是對的。
     *
     * 可選依賴照 opkg 的 `Suggests` 辦：列出來，不預裝。
     */
    if (node.kind === DEP_KIND.PACKAGE) {
      if (node.required !== false && node.download?.package_id) supply.push(node.download);
      continue;
    }
    if (node.kind !== DEP_KIND.CAPABILITY) continue;
    const candidates = providers(node.id, DEP_KIND.CAPABILITY);
    if (!candidates.length) continue;
    node.providers = candidates;
    if (candidates.length === 1) supply.push(candidates[0]);
    else node.needs_choice = true;
  }

  /**
   * ⚠ 去重只在 `supply` **自己內部**做。
   *
   * 先前它拿 `install_order` 當「已排定」——而那份清單裡裝的正是每一個缺席的 Package
   * 依賴，於是它們被當成「已經安排好了」而從 supply 裡剔除乾淨。可是真正去下載的
   * 只有 supply：`install_order` 從頭到尾沒有任何執行者。一個算得出來、印得出來、
   * 卻沒人照著做的清單，比沒有這份清單更難發現。
   *
   * 這裡要防的是同一個包被排兩次（一個 Capability 的提供方同時也被顯式宣告為
   * Package 依賴），按 package_id 去重即可。
   */
  const seen = new Set();
  const additions = supply.filter((item) => {
    if (!item.package_id || seen.has(item.package_id)) return false;
    seen.add(item.package_id);
    return true;
  });
  if (!additions.length) return plan;
  return {
    ...plan,
    // 缺的能力現在補得上，所以它不再是「裝不了」的理由。
    installable: plan.installable
      && !(plan.missing_from_catalog ?? []).some((node) => node.kind === DEP_KIND.PACKAGE),
    download_bytes: (plan.download_bytes ?? 0)
      + additions.reduce((sum, item) => sum + (item.size ?? 0), 0),
    install_order: [...(plan.install_order ?? []), ...additions.map((item) => item.package_id)],
    supply: additions,
  };
}

/**
 * 服務啟動門禁。依賴沒 ready 就不啟動，並回一個**結構化**的原因。
 *
 * ⚠ 錯誤必須結構化而不是一句話：WebUI 要據此列出缺了什麼、跳到哪去補。
 * 一句 "dependencies not ready" 對使用者的價值等於沒說。
 *
 * ⭐ Dev override 只認**開發掛載**上的旗標（`record.dev`）。它刻意不從 Manifest 讀——
 * 正式 Release 若能自己宣告「跳過依賴檢查」，這道門就是給守規矩的包設的，
 * 而只擋君子的門不是門。用了 override 一定寫進日誌與狀態，不許無聲通過。
 */
export async function serviceDependencyGate(def, { log = () => {} } = {}) {
  const packageId = def?.package;
  if (!packageId) return { ok: true, reason: 'core_service' };
  const record = getPackage(packageId);
  if (!record?.manifest) return { ok: true, reason: 'no_manifest' };
  const resolved = await resolvePackageDependencies(record.manifest);
  if (resolved.ready) return { ok: true, reason: 'satisfied', ...resolved };

  const override = record.dev?.dependency_override === true;
  if (override) {
    log(`dependency override: starting ${def.id} with ${resolved.blocked.length} unmet dependency(ies)`);
    return { ok: true, reason: 'dev_override', overridden: true, ...resolved };
  }
  return {
    ok: false,
    error: 'dependencies_not_ready',
    reason: 'blocked',
    package: packageId,
    blocked: resolved.blocked.map((node) => ({
      kind: node.kind, id: node.id, state: node.state, blocked_by: node.blocked_by,
      required_version: node.version ?? null, installed_version: node.installed_version ?? null,
    })),
    ...resolved,
  };
}

/** 反向依賴：誰在依賴我。⛔ 卸載前必問——被別人依賴的東西不許刪。 */
export function reverseDependencies(targetId, { kind = DEP_KIND.PACKAGE } = {}) {
  const users = [];
  for (const summary of listPackages()) {
    const record = getPackage(summary.id);
    if (!record?.manifest || record.id === targetId) continue;
    const uses = declaredDependencies(record.manifest)
      .some((node) => node.kind === kind && node.id === targetId);
    if (uses) users.push({ id: record.id, name: record.manifest.name ?? record.id });
  }
  return users;
}

export { DEP_STATE, DEP_KIND };

// ============================================================
// 自檢：node src/packages/dependency-runtime.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve: resolvePath } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails += 1; };

  const coords = (id, version) => ({
    package_id: id, source: 'huggingface', repository: `owner/${id}`,
    version, kind: 'source_tar', file: `package/${id}-${version}.tar.gz`, size: 100, sha256: 'a'.repeat(64),
  });
  const catalog = (id) => (id.startsWith('pkg.') ? coords(id, '1.0.0') : null);
  const providers = (id) => (id === 'cap.one' ? [coords('pkg.provider', '2.0.0')] : []);

  const declared = [
    { kind: DEP_KIND.PACKAGE, id: 'pkg.required', version: '>=1.0.0', required: true },
    { kind: DEP_KIND.PACKAGE, id: 'pkg.optional', version: '>=1.0.0', required: false },
    { kind: DEP_KIND.CAPABILITY, id: 'cap.one', required: true },
  ];
  const plan = resolveDeclaredDependencies(declared, { catalog, providers });
  const supplied = (plan.supply ?? []).map((item) => item.package_id).sort();

  /**
   * ⭐ 這條抓的是一個真的漏出去過的缺陷：迴圈只認 Capability，於是帶著完整下載坐標的
   * Package 依賴被整整跳過——安裝「成功」，裝出來的包缺著它宣告過的必需依賴。
   */
  t('a missing required package dependency is installed alongside the target',
    supplied.includes('pkg.required'));
  t('a capability is still translated into the package that provides it',
    supplied.includes('pkg.provider'));
  t('an optional dependency is listed but never installed for you',
    !supplied.includes('pkg.optional'));

  const noCoords = resolveDeclaredDependencies(
    [{ kind: DEP_KIND.PACKAGE, id: 'ghost.pkg', required: true }],
    { catalog: () => null, providers: () => [] },
  );
  t('a required package the catalog cannot supply blocks the install instead of being skipped',
    noCoords.installable === false
    && (noCoords.missing_from_catalog ?? []).some((n) => n.id === 'ghost.pkg'));

  process.exit(fails ? 1 : 0);
}
