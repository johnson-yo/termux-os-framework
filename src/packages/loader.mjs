/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: Package lifecycle registries, HTTP route dispatch, and authenticated WebSocket route dispatch.
 * [POS]: src/packages/loader.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MANIFEST_FILENAME, validateManifest, manifestTargets, selectAssetDeclaration, TARGET_GENERIC,
} from './manifest.mjs';
import { resolveInstalledPackages } from './installed-root.mjs';
import { preflight, deviceProfile } from './runtime-contract.mjs';
import { activateAsset, assetVersionDir } from '../assets/registry.mjs';
import { registerAction, getAction, unregisterAction } from '../theatre/runtime.mjs';
import { getState, listStates, registerState, setState, unregisterPackageStates } from '../state/registry.mjs';
import {
  registerAssetProvider, listAssets, unregisterAssetProvider, getAssetProvider, fetchOptionalAsset,
  resolveAsset as resolveAssetById, describeAsset as describeAssetById,
} from '../assets/runtime.mjs';
// 循環 import（resolver 反向 import 本檔的 listCapabilityProviders/getPackage）——只在 context 方法
// 運行時調用，非 top-level，ESM 惰性綁定安全。鏡像 context.assets.resolve/describe 的既有形態。
import { describeCapability, invokeCapability } from '../capabilities/resolver.mjs';
import { services as stageServices, getServiceDef } from '../stage/catalog.mjs';
import { restartService } from '../stage/manager.mjs';
import { getPackagePorts, registerPackagePorts, prunePackagePorts } from '../system/port-registry.mjs';
import { isPackageEnabled } from '../system/package-settings.mjs';
import { nodeExecutable } from '../system/node-runtime.mjs';

// ============================================================
// Registry（模塊級單例；self-test 用獨立掃描根避免污染正式登記）
// ============================================================
const packages = new Map();        // id → record
// 載入時記下的 Catalog 地址：按需取資產要用它，而那條路徑不經過 loadPackages 的參數。
let loadedRegistryBase = '';
const registeredApps = new Map();  // appId → { ...app, package }
const providers = new Map();       // `${capabilityId}:${providerId}` → { ...provider, package }
const routes = new Map();          // packageId → [{ method, path, handler }]
const websocketRoutes = new Map(); // packageId → [{ path, handler }]
// 029 §12：Integration Contract / Artifact 只讀契約——皆來自 Manifest 宣告（載入時登記，卸載時回收）
const integrationProvides = new Map(); // capabilityId → packageId
const artifactContracts = new Map();   // artifactId → { ...descriptor, package }

// ============================================================
// Runtime Contract 就緒（023 §10）
// ============================================================
const RUNTIME_TTL_MS = 15000; // 探測要跑 python import/文件檢查，不能每次輪詢都來一遍

/** Manifest 的 framework_action 探測交給 Core 的 Action Registry：只看有沒有註冊，不 invoke（禁副作用） */
const actionProbe = (actionId) => (getAction(actionId)
  ? { ok: true }
  : { ok: false, reason: `action "${actionId}" not registered (is its package installed?)` });

/** 029 §12：integration capability 探測——看有沒有已載入的 Package 宣告 provides；不探 App 進程本身 */
const integrationProbe = (cap) => (integrationProvides.has(cap)
  ? { ok: true, provider: integrationProvides.get(cap) }
  : { ok: false, reason: `no loaded package declares integration "${cap}"` });

export const listArtifactContracts = () => [...artifactContracts.values()];

/** 首頁只要一句話（§10：不把依賴清單堆回首頁） */
function runtimeSummary(r) {
  if (!r) return null;
  if (!r.declared) return 'Legacy / Not declared';
  if (!r.target.ok) return r.target.verdict === 'mismatch' ? 'Target mismatch' : 'Target unconfirmed';
  if (!r.bundled.ok) return 'Missing bundled artifact';
  if (r.external.some((i) => i.ok === false && i.required)) return 'Missing dependency';
  // 029 §12.3：required integration 缺=不就緒；optional 缺=可啟動但如實標 degraded
  if ((r.integrations ?? []).some((i) => i.ok === false && i.required)) return 'Missing integration';
  if ((r.integrations ?? []).some((i) => i.ok === false && !i.required)) return 'Degraded';
  return 'Ready';
}

export function getPackageRuntime(id, { refresh = false } = {}) {
  const r = packages.get(id);
  if (!r || !r.manifest) return null;
  const fresh = r.runtimeCache && Date.now() - r.runtimeCache.at < RUNTIME_TTL_MS;
  if (fresh && !refresh) return r.runtimeCache.value;
  // 未聲明 runtime/targets 的舊 Package：legacy/generic，不強制改（§3.2）
  const declared = !!(r.manifest.runtime || r.manifest.targets);
  let value;
  try {
    value = { declared, ...preflight(r.dir, r.manifest, { ctx: { actionProbe, integrationProbe } }), checked_at: new Date().toISOString() };
  } catch (e) {
    value = { declared, ok: false, error: String(e?.message ?? e), checked_at: new Date().toISOString() };
  }
  value.summary = runtimeSummary(value);
  r.runtimeCache = { at: Date.now(), value };
  return value;
}

export const listPackages = () => [...packages.values()].map((r) => ({
  id: r.id, name: r.manifest?.name ?? null, version: r.manifest?.version ?? null,
  types: r.manifest?.types ?? [], status: r.status, error: r.error ?? null,
  source: r.source ?? 'root', install: r.install ?? null,
  runtime: r.status === 'loaded' ? (getPackageRuntime(r.id)?.summary ?? null) : null,
  target: r.manifest?.targets?.[0]?.id ?? 'generic',
  ports: getPackagePorts(r.id),
  dev: r.dev ?? null, // 029：Dev Mount 標記（workspace/shadow 等，正式包=null）
}));

export const getPackage = (id) => {
  const r = packages.get(id);
  if (!r) return null;
  return { id: r.id, packageId: r.packageId ?? r.id,
    dir: r.dir, status: r.status, error: r.error ?? null, manifest: r.manifest ?? null,
    source: r.source ?? 'root', install: r.install ?? null, dev: r.dev ?? null,
    ports: getPackagePorts(id),
    registered: { services: [...(r.registered?.services ?? [])], apps: [...(r.registered?.apps ?? [])], states: [...(r.registered?.states ?? [])] },
    runtime: r.status === 'loaded' ? getPackageRuntime(id) : null };
};

export const getPackageWebRoot = (id) => {
  const r = packages.get(id);
  return r && r.status === 'loaded' ? r.webRoot : null;
};

/**
 * 按需取一個可選資產。
 *
 * ⭐ **消費方只說得出一個 asset id。** 坐標、硬件檔位、落盤位置全部來自宣告它的那個包——
 * 讓消費方傳 URL 或路徑，就等於讓「這台機器上的這個資產到底是什麼」有兩個來源，
 * 而那個問題必須只有一個答案。所以 speech 想要 SenseVoice 的 ctx 時，它問的是
 * `model.sensevoice.ctx`，至於那是 V73 還是 V79 的那一份、從哪個 revision 取，
 * 它既不知道也不需要知道。
 *
 * ⭐ **落盤目錄用資產自己的 target，不是包的。** 包可以是 generic 而載荷是 V73 專屬的；
 * 兩個硬件版本若落進同一個目錄就會互相覆蓋，而 EPContext 的 wrapper 以 `./model.bin`
 * 引用它的 context binary——同名不同機的那一份會被照常打開，然後在加載期報
 * `Error code: 5000`。目錄隔離是這裡唯一的防線，所以它由框架給，不靠宣告的人自覺。
 */
/**
 * 正在取的资产。
 *
 * ⚠ 下载是**服务端**的事，而页面刷新一次就忘了自己点过——于是同一个资产会被第二次
 * 点下去，两个下载写同一个 `.part`。落盘的字节数看起来一直在涨，校验却必然失败。
 * 谁在取这件事必须由知道它的一方说出来。
 */
const fetchingAssets = new Map(); // assetId → started_at

export const assetFetchInFlight = (assetId) => fetchingAssets.get(assetId) ?? null;

export async function fetchAssetOnDemand(assetId, {
  onProgress = () => {},
  // 沒給就用載入時記下的那一個；⛔ 不預設一個公網地址——Catalog 地址是部署決定，
  // 在這裡編一個出來會讓「它到底去哪裡取」變成一個要讀源碼才知道的問題。
  registryBase = loadedRegistryBase,
  ...rest
} = {}) {
  const provider = getAssetProvider(assetId);
  if (!provider) {
    return { ok: false, error: 'unknown_asset', detail: `no installed package declares ${assetId}` };
  }
  const owner = packages.get(provider.package);
  const manifest = owner?.manifest;
  if (!manifest) {
    return { ok: false, error: 'provider_not_loaded', detail: `${provider.package} declares ${assetId} but is not loaded` };
  }
  if (fetchingAssets.has(assetId)) {
    return { ok: false, error: 'already_fetching', detail: `${assetId} is already being fetched`,
      started_at: fetchingAssets.get(assetId) };
  }
  const packageTarget = manifestTargets(manifest)[0]?.id ?? TARGET_GENERIC;
  fetchingAssets.set(assetId, new Date().toISOString());
  try {
    return await fetchOptionalAsset(assetId, {
    ...rest,
    packageManifest: manifest,
    onProgress,
    registryBase,
    storeDirFor: (declared) => path.join(
      assetVersionDir(manifest.id, manifest.version, declared.target?.id ?? packageTarget),
      path.basename(declared.payload),
    ),
    activate: (declared, dir, checksums) => activateAsset(assetId, {
      package_id: manifest.id,
      version: manifest.version,
      target: declared.target?.id ?? packageTarget,
      target_spec: declared.target ?? null,
      path: dir,
      files: declared.files ?? {},
      checksums,
      sha256: Object.values(checksums)[0] ?? null,
      fetched_on_demand: true,
    }),
    });
  } finally {
    fetchingAssets.delete(assetId);
  }
}

/** 這台機器該用哪一份載荷宣告——狀態頁與 CLI 用來說明「有幾檔、你是哪一檔」。 */
export function describeAssetVariants(assetId, profile = deviceProfile()) {
  const provider = getAssetProvider(assetId);
  const manifest = provider ? packages.get(provider.package)?.manifest : null;
  if (!manifest) return null;
  const picked = selectAssetDeclaration(manifest, assetId, profile);
  return {
    asset: assetId,
    package: manifest.id,
    candidates: picked.candidates,
    selected: picked.ok ? (picked.declaration.target?.id ?? TARGET_GENERIC) : null,
    // 正在取吗。⚠ 页面刷新后客户端不记得自己点过，只有这一侧说得出。
    fetching: assetFetchInFlight(assetId),
    reason: picked.ok ? null : picked.error,
    detail: picked.ok ? null : picked.detail,
  };
}

export function dispatchPackageRoute(id, method, subpath) {
  const list = routes.get(id);
  if (!list) return null;
  return list.find((x) => x.method === method && x.path === subpath)?.handler ?? null;
}

export function dispatchPackageWebSocket(id, subpath) {
  const list = websocketRoutes.get(id);
  if (!list) return null;
  return list.find((x) => x.path === subpath)?.handler ?? null;
}

export const listRegisteredApps = () => [...registeredApps.values()];
export const listCapabilityProviders = () => [...providers.values()];
export const getRegisteredApp = (id) => registeredApps.get(id) ?? null;

// ============================================================
// 029 Dev Runtime 支撐：卸載 + 單包重載（僅 dev-runtime.mjs 使用；正式安裝仍走 Installer）
// ============================================================
/** 取原始 record（含 registered 清單/webRoot 等內部字段）——dev-runtime 專用內部口 */
export const _getRecord = (id) => packages.get(id) ?? null;

/**
 * 把一個 Package 從所有註冊表撤下並返回其 record。
 * 只清登記不停進程——調用方（dev-runtime）必須先停掉該包的 Stage Service。
 * failed Package 的部分註冊殘留也在此一併回收（v0 已知限制的 dev 側補救）。
 */
export async function unregisterPackage(id) {
  const r = packages.get(id);
  if (!r) return null;
  const cleanupErrors = [];
  for (const cleanup of [...(r.registered.cleanups ?? [])].reverse()) {
    try { await cleanup(); }
    catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
  }
  r.registered.cleanups = [];
  for (const aid of r.registered.actions) unregisterAction(aid);
  // 沒有知情者的事實就是謊言：包一卸載，它寫的狀態立刻消失，而不是留著最後一個值。
  unregisterPackageStates(id);
  for (const sid of r.registered.services) {
    const i = stageServices.findIndex((s) => s.id === sid);
    if (i >= 0) stageServices.splice(i, 1);
  }
  for (const appId of r.registered.apps) registeredApps.delete(appId);
  for (const key of r.registered.providers) providers.delete(key);
  for (const assetId of r.registered.assets) unregisterAssetProvider(assetId);
  for (const cap of r.registered.integrations ?? []) integrationProvides.delete(cap);
  for (const aid of r.registered.artifactContracts ?? []) artifactContracts.delete(aid);
  routes.delete(id);
  websocketRoutes.delete(id);
  packages.delete(id);
  if (cleanupErrors.length) r.cleanup_errors = cleanupErrors;
  return r;
}

/** 單包載入（dev-runtime 用）：cacheBust 給 entry import 加查詢串避開 ESM 模塊快取 */
export async function loadSinglePackage({ dir, expectId, source, install = null,
  contextOverrides = null, cacheBust = false }, opts) {
  await loadCandidate({ dir, expectId, source, install, contextOverrides, cacheBust }, opts);
  return packages.get(expectId) ?? null;
}

// ============================================================
// Package Context —— register(context) 能看到的全部能力（021 §5：不開放 Framework 內部對象）
// ============================================================
/**
 * Where a Package keeps its own settings: `config/` under the Package root, beside `versions/`
 * rather than inside one, so upgrading the Package does not discard what the user configured.
 * A workspace instance is deliberately given its own directory — it exists to try changes out,
 * and writing them into the released Package's settings is what coexistence is meant to prevent.
 */
function packageConfigRoot(record, overrides) {
  // overrides.persistRoot 仍然保留給非 dev 的注入場景（測試夾具）；dev 本身不再注入，
  // 它讀寫的就是正式那一份配置。
  if (overrides?.persistRoot) return path.join(overrides.persistRoot, 'config');
  if (record.packageRoot) return path.join(record.packageRoot, 'config');
  /**
   * 原始目錄掃描（self-test / doctor）沒有安裝根。
   *
   * ⚠ 這裡曾經回退到 `record.dir/config`，也就是**包目錄之內**。新模型下包目錄就是
   * Git 工作樹，往裡面寫配置會讓一個從未被人碰過的包在第一次運行後就變成 dev。
   * 落在同層的兄弟目錄，語義不變（配置與代碼分離），但工作樹保持乾淨。
   */
  return path.join(path.dirname(record.dir), `${path.basename(record.dir)}.config`);
}

function makeContext(record, config, configPath, overrides = null, saveConfig = null) {
  const id = record.id;
  const tag = `[pkg ${id}]`;
  /**
   * 名字不再被命名空間化。
   *
   * 舊模型讓工作區以 `<id>@<slug>` 與正式版並排運行，於是每個全局鍵都要加後綴才不
   * 撞車。新模型只有一份 package：release 與 dev 共用同一個 service id、app id、
   * port、URL、config 與 data——「同態」的字面意思就是這裡不能有兩套名字。
   */
  const ns = (localId) => localId;
  const frameworkRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  return {
    packageId: id,
    root: record.dir,
    frameworkRoot, // Service cwd 用
    nodeExecutable: nodeExecutable(), // Termux may report the Android linker as process.execPath.
    // Package 持久配置根：/sdcard（真機）或 .runtime/persist（開發機回退，不入庫）；
    // 029：Dev Mount 默認注入隔離資料區（overrides.persistRoot），不碰正式 config/data
    persistRoot: overrides?.persistRoot ?? (fs.existsSync('/sdcard/termux-os')
      ? '/sdcard/termux-os/framework' : path.join(frameworkRoot, '.runtime/persist')),
    // Package 自己的設定檔位置。過去 SDK 模板教大家寫 persistRoot/conf/<名字>，也就是
    // Framework 自己的 conf 目錄：於是 Package 的設定跟著 Framework 的持久樹走，重裝
    // Framework 就可能連 Package 的設定一起丟，而更新邊界檢查也在逐位元組盯著那棵樹。
    // 現在放在 Package 根目錄下的 config/，與 versions/ 平行——所以它同時活過
    // Framework 更新與 Package 自身升級。舊位置存在時第一次取用就搬過來，不用誰去改。
    configRoot: packageConfigRoot(record, overrides),
    configFile(name = `${record.packageId ?? id}.v1.json`) {
      const root = packageConfigRoot(record, overrides);
      const target = path.join(root, name);
      if (!fs.existsSync(target)) {
        const legacy = path.join(overrides?.persistRoot
          ?? (fs.existsSync('/sdcard/termux-os') ? '/sdcard/termux-os/framework' : path.join(frameworkRoot, '.runtime/persist')),
        'conf', name);
        if (fs.existsSync(legacy)) {
          fs.mkdirSync(root, { recursive: true });
          fs.copyFileSync(legacy, target);
          // 舊檔留著不刪：降級回舊版本的 Package 仍然要讀得到它。
          console.log(tag, `moved configuration from ${legacy} to ${target}`);
        }
      }
      fs.mkdirSync(root, { recursive: true });
      return target;
    },
    // framework 級配置的受限寫口：只許 patch 自己相關的 integrations 子樹（android-app 等 Adapter 用）；
    // in-memory 同步更新（Action 閉包持同一對象引用，保存即生效），並持久化到當前 CONFIG 文件
    frameworkConfig: {
      integration: (name) => config?.integrations?.[name] ?? null,
      updateIntegration(name, patch) {
        if (!config?.integrations?.[name]) throw new Error(`unknown integration "${name}"`);
        const allowed = ['enabled', 'url', 'token'];
        for (const k of Object.keys(patch)) {
          if (!allowed.includes(k)) throw new Error(`integration field "${k}" not updatable`);
        }
        Object.assign(config.integrations[name], patch);
        // 交給 Framework 落盤：它知道哪些欄位是運行期解析出來的，不可寫入檔案。
        if (saveConfig) saveConfig();
        else if (configPath) fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
        return config.integrations[name];
      },
    },
    logger: {
      info: (...a) => console.log(tag, ...a),
      warn: (...a) => console.warn(tag, ...a),
      error: (...a) => console.error(tag, ...a),
    },
    config, // framework 級配置（integrations 等）；Package 專屬配置由 Package 自己讀寫
    // All Package-to-Package and third-party HTTP calls use the current Core System Key.
    // It is a getter so an in-process rotation is visible without leaking a copied secret.
    auth: {
      systemKey: () => String(config?.auth?.admin_token ?? ''),
      frameworkUrl: `http://127.0.0.1:${Number(config?.server?.port) || 8980}`,
    },
    lifecycle: {
      register(cleanup) {
        if (typeof cleanup !== 'function') throw new Error('lifecycle cleanup must be a function');
        record.registered.cleanups.push(cleanup);
      },
    },
    ports: {
      list: () => getPackagePorts(id),
      get: (portId) => getPackagePorts(id).find((port) => port.id === portId) ?? null,
      primary: () => getPackagePorts(id)[0] ?? null,
    },
    // 024：Asset —— 提供方登記自己帶的模型；使用方（如 speech.asr）啟動前 resolve 問路。
    // 給的是**已驗證的路徑與狀態**，不是模型內容（§7.1）
    assets: {
      register(asset) {
        const rec = registerAssetProvider({ ...asset, package: id });
        record.registered.assets.push(asset.id);
        return rec;
      },
      resolve: (assetId, opts) => resolveAssetById(assetId, opts),
      describe: (assetId, opts) => describeAssetById(assetId, opts),
      list: (opts) => listAssets(opts),
      fetch: (assetId, opts) => fetchAssetOnDemand(assetId, opts),
    },
    // 狀態總線（第三種機制）。Capability 回答「誰能提供這個能力」，可多家競標由綁定裁決；
    // state 回答「這件事此刻的事實是什麼」，只能有一個知情者，所以沒有綁定也不許重名。
    // 寫入者 push（本進程內的包直接 set，獨立服務走 POST /api/states），讀取者 GET。
    states: {
      register(declaration) {
        const entry = registerState({ ...declaration, package: id });
        record.registered.states.push(entry.name);
        return entry;
      },
      set: (name, value) => setState(name, value, { package: id }),
      get: (name) => getState(name),
      list: () => listStates(),
    },
    actions: {
      register(action) {
        const existing = getAction(action.id);
        if (existing) {
          throw new Error(`duplicate action id "${action.id}": already registered by ${existing.package ?? `adapter ${existing.adapter}`}, rejected for ${id}`);
        }
        registerAction({ ...action, package: id });
        record.registered.actions.push(action.id);
      },
    },
    services: {
      /**
       * The instance-scoped id of a service this package declares.
       *
       * Namespacing the registration alone is not enough: a package computes its own
       * runtime paths (status file, pid file) from its literal service id, so two
       * instances would read and write the same files while appearing isolated.
       * Packages must derive those paths from this, not from a local constant.
       */
      id: (localId) => ns(localId),
      /**
       * 重啟本包自己註冊的一個 worker。
       *
       * ⭐ 存在的理由是「配置只在啟動時讀一次」：改完配置讓使用者自己記得再按一次
       * 重啟，等於把一個必然的步驟做成一個可以忘的步驟。
       *
       * ⛔ 只能重啟**自己註冊過的** id。包能重啟別人的服務，就等於一個包可以把
       * 另一個包停掉，而擁有者對此一無所知。
       */
      async restart(localId) {
        const serviceId = ns(localId);
        if (!record.registered.services.includes(serviceId)) {
          throw new Error(`${id} did not register service "${serviceId}"`);
        }
        return restartService(serviceId);
      },
      register(def) {
        const serviceId = ns(def.id);
        const existing = getServiceDef(serviceId);
        if (existing) {
          throw new Error(`duplicate service id "${serviceId}": already registered by ${existing.package ?? 'core'}, rejected for ${id}`);
        }
        const packagePorts = getPackagePorts(id);
        const portEnv = Object.fromEntries(packagePorts.flatMap((port) => {
          const suffix = port.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
          const host = port.visibility === 'lan' ? '0.0.0.0' : '127.0.0.1';
          return [
            [`TERMUX_OS_PORT_${suffix}`, String(port.port)],
            [`TERMUX_OS_PORT_${suffix}_VISIBILITY`, port.visibility],
            [`TERMUX_OS_PORT_${suffix}_HOST`, host],
          ];
        }));
        if (packagePorts[0]) portEnv.PORT = String(packagePorts[0].port);
        stageServices.push({
          ...def,
          id: serviceId,
          // App 型 Package 的 worker 標明主人；服務頁據此不把它當系統服務列出。
          app: def.app ? ns(def.app) : null,
          command: def.command === process.execPath ? nodeExecutable() : def.command,
          package: id,
          env: {
            ...(def.env ?? {}),
            TERMUX_OS_SYSTEM_KEY: String(config?.auth?.admin_token ?? ''),
            TERMUX_OS_FRAMEWORK_URL: `http://127.0.0.1:${Number(config?.server?.port) || 8980}`,
            TERMUX_OS_PACKAGE_ID: id,
            ...portEnv,
          },
        });
        record.registered.services.push(serviceId);
      },
    },
    apps: {
      register(app) {
        if (!app?.id) throw new Error('app.id is required');
        const appId = ns(app.id);
        const existing = registeredApps.get(appId);
        if (existing) {
          throw new Error(`duplicate app id "${appId}": already registered by ${existing.package}, rejected for ${id}`);
        }
        registeredApps.set(appId, { ...app, id: appId, package: id });
        record.registered.apps.push(appId);
      },
    },
    capabilities: {
      provide(p) {
        if (!p?.id || !p?.provider) throw new Error('capability provider needs id and provider');
        const key = `${p.id}:${p.provider}`;
        const existing = providers.get(key);
        if (existing) {
          throw new Error(`duplicate provider "${key}": already registered by ${existing.package}, rejected for ${id}`);
        }
        providers.set(key, { ...p, package: id });
        record.registered.providers.push(key);
      },
      // 消費側對稱口（鏡像 assets.resolve/describe）：Package 服務端按 Capability id 調用/問路，
      // 由 resolver 解析當前綁定 Provider，回的是純數據（同 /api/capabilities/.../invoke）。
      // 用於後台無瀏覽器場景（如 chat live-loop 經 speech.speak 走 Audio Gate 播放）。
      describe: (capId) => describeCapability(capId),
      invoke: (capId, input) => invokeCapability(capId, input),
    },
    routes: {
      register(method, subpath, handler) {
        if (typeof handler !== 'function') throw new Error(`route handler for ${method} ${subpath} must be a function`);
        if (!routes.has(id)) routes.set(id, []);
        const list = routes.get(id);
        const norm = subpath.startsWith('/') ? subpath : `/${subpath}`;
        if (list.some((x) => x.method === method && x.path === norm)) {
          throw new Error(`duplicate route ${method} ${norm} in ${id}`);
        }
        list.push({ method, path: norm, handler });
      },
    },
    websockets: {
      register(subpath, handler) {
        if (typeof handler !== 'function') throw new Error(`WebSocket handler for ${subpath} must be a function`);
        if (!websocketRoutes.has(id)) websocketRoutes.set(id, []);
        const list = websocketRoutes.get(id);
        const norm = subpath.startsWith('/') ? subpath : `/${subpath}`;
        if (list.some((x) => x.path === norm)) {
          throw new Error(`duplicate WebSocket route ${norm} in ${id}`);
        }
        list.push({ path: norm, handler });
        record.registered.websockets.push(norm);
      },
    },
  };
}

// ============================================================
// Loader —— 掃描/驗證/載入；任何一步失敗只 failed 該 Package
// 022：默認來源 = Installed Root（~/.termux-os/packages，active.json→versions/<v>）；
//      開發樹須顯式 PACKAGES_DEV_DIR，測試附加根 PACKAGES_EXTRA_DIR；roots 參數（self-test/doctor）
//      維持原始目錄掃描語義
// ============================================================
async function loadCandidate({ dir, expectId, source, install, contextOverrides = null, cacheBust = false,
  packageRoot = null },
  { frameworkVersion, config, configPath, saveConfig, log }) {
  const manifestPath = path.join(dir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    if (source === 'installed') {
      packages.set(expectId, { id: expectId, dir, manifest: null, status: 'failed', source, install,
        error: `installed version has no ${MANIFEST_FILENAME}`, registered: { actions: [], services: [], apps: [], providers: [], assets: [], websockets: [], states: [], cleanups: [] } });
      log(`package ${expectId}: FAILED — installed version has no manifest`);
    }
    return; // 原始掃描根下無 Manifest 的目錄=非 Package，跳過
  }

  const fail = (id, manifest, error) => {
    packages.set(id, { id, dir, manifest, status: 'failed', source, install, error, registered: { actions: [], services: [], apps: [], providers: [], assets: [], websockets: [], states: [], cleanups: [] } });
    log(`package ${id}: FAILED — ${error}`);
  };

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return fail(expectId, null, `manifest parse error: ${String(e?.message ?? e)}`); }

  const v = validateManifest(manifest, { frameworkVersion });
  if (!v.ok) return fail(manifest?.id && !packages.has(manifest.id) ? manifest.id : expectId, manifest, `manifest invalid: ${v.errors.join('; ')}`);

  const packageId = manifest.id;
  // 一個 package id 就是一個實體。此前這裡可以派生出 `<id>@<slug>` 的第二身分。
  const id = packageId;
  if (expectId !== id) {
    return fail(packages.has(id) ? expectId : id, manifest,
      source === 'installed'
        ? `manifest id "${packageId}" does not match installed package "${expectId}"`
        : `directory name "${expectId}" must equal package id "${packageId}"`);
  }
  const existing = packages.get(id);
  if (existing) return fail(`${id}@${source}`, manifest, `duplicate package id "${id}": already provided by ${existing.dir} (${existing.source}), rejected for ${dir} (${source})`);

  const record = {
    id, packageId, dir, packageRoot, manifest, source, install, status: 'loaded', error: null,
    webRoot: path.join(dir, path.dirname(manifest.entrypoints.webui)),
    registered: { actions: [], services: [], apps: [], providers: [], assets: [], websockets: [], states: [], cleanups: [] },
  };

  if (manifest.disabled === true || !isPackageEnabled(id)) {
    record.status = 'disabled';
    record.error = manifest.disabled === true ? 'disabled by Manifest' : 'disabled in Package Setting';
    packages.set(id, record);
    log(`package ${id}: disabled`);
    return;
  }
  if (!v.compatible) {
    record.status = 'incompatible';
    record.error = `requires framework ${manifest.compatibility.framework}, current ${frameworkVersion}`;
    packages.set(id, record); log(`package ${id}: incompatible — ${record.error}`); return;
  }

  const backendPath = path.join(dir, manifest.entrypoints.backend);
  const webuiPath = path.join(dir, manifest.entrypoints.webui);
  if (!fs.existsSync(backendPath)) return fail(id, manifest, `backend not found: ${manifest.entrypoints.backend}`);
  if (!fs.existsSync(webuiPath)) return fail(id, manifest, `webui entry not found: ${manifest.entrypoints.webui}`);

  try {
    // Ports are keyed by package id, and a workspace instance has its own id, so the
    // allocator hands it a different port and avoids the released one by construction.
    // Denying ports outright was wrong: a package that needs one could not run at all
    // in a workspace — it failed to register with "did not assign the HTTP port".
    // The globally-scoped claims are integrations and artifact contracts, which resolve
    // by capability name to exactly one owner; those a workspace still must not take.
    record.ports = registerPackagePorts(id, manifest.ports ?? []);
    // 029：dev 重載時 entry 加查詢串繞開 ESM 快取（子模塊靠 dev-runtime 的 generation 副本換新 URL）
    const entryUrl = pathToFileURL(backendPath).href + (cacheBust ? `?dev=${Date.now()}` : '');
    const mod = await import(entryUrl);
    if (typeof mod.register !== 'function') throw new Error('backend must export async function register(context)');
    packages.set(id, record); // 先入表：register 內的衝突錯誤能指回本 Package
    // 054：Manifest 宣告的狀態先登記，register() 裡才能直接 set。聲明式的好處是
    // **不跑起來也能審計整個命名空間**——誰負責告訴大家什麼，裝之前就看得見。
    for (const declaration of manifest.states?.provides ?? []) {
      const entry = registerState({
        ...declaration,
        name: declaration.id,
        package: id,
        service: declaration.service ?? null,
      });
      record.registered.states.push(entry.name);
    }
    await mod.register(makeContext(record, config, configPath, contextOverrides, saveConfig));
    // 029 §12：Manifest 宣告的 integration/artifact 契約在載入成功後登記（先到先得，卸載時回收）
    record.registered.integrations = [];
    record.registered.artifactContracts = [];
    for (const cap of manifest.integrations?.provides ?? []) {
      if (!integrationProvides.has(cap)) { integrationProvides.set(cap, id); record.registered.integrations.push(cap); }
    }
    for (const a of manifest.artifacts?.provides ?? []) {
      if (!artifactContracts.has(a.id)) { artifactContracts.set(a.id, { ...a, package: id }); record.registered.artifactContracts.push(a.id); }
    }
    log(`package ${id}: loaded ${manifest.version} (${manifest.types.join(',')}) [${source}]`);
  } catch (e) {
    // A Package may have opened a resource before a later registration failed.
    // Run the lifecycle cleanup before leaving the failed record observable.
    for (const cleanup of [...(record.registered.cleanups ?? [])].reverse()) {
      try { await cleanup(); } catch { /* preserve the original register error */ }
    }
    record.registered.cleanups = [];
    record.status = 'failed';
    record.error = `register failed: ${String(e?.message ?? e)}`;
    // A failed Package must not reserve a port that no running Package owns.
    try { registerPackagePorts(id, []); } catch { /* preserve the original load error */ }
    packages.set(id, record);
    log(`package ${id}: FAILED — ${record.error}`);
  }
}

const scanRawRoot = (root, source) => {
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return []; } // 掃描根不存在=沒有 Package，非錯誤
  return dirs.map((dirname) => ({ dir: path.join(root, dirname), expectId: dirname, source, install: null }));
};

export async function loadPackages({ roots, frameworkVersion, config = {}, configPath = null, saveConfig = null, registryBase = '', log = console.log } = {}) {
  loadedRegistryBase = registryBase || config?.integrations?.package_registry?.base_url || '';
  const opts = { frameworkVersion, config, configPath, saveConfig, log };
  const candidates = [];

  if (roots) {
    for (const root of roots) candidates.push(...scanRawRoot(root, 'root'));
  } else {
    const { entries, errors } = resolveInstalledPackages();
    for (const e of errors) {
      packages.set(e.id, { id: e.id, dir: e.dir, manifest: null, status: 'failed', source: 'installed', install: null,
        error: e.error, registered: { actions: [], services: [], apps: [], providers: [], assets: [], websockets: [], states: [], cleanups: [] } });
      log(`package ${e.id}: FAILED — ${e.error}`);
    }
    for (const en of entries) {
      candidates.push({ dir: en.dir, expectId: en.id, source: 'installed', packageRoot: en.packageRoot,
        install: { version: en.active.active_version, previous_version: en.active.previous_version ?? null,
          archive_sha256: en.active.archive_sha256 ?? null, installed_at: en.active.installed_at ?? null } });
    }
    if (process.env.PACKAGES_DEV_DIR) candidates.push(...scanRawRoot(process.env.PACKAGES_DEV_DIR, 'dev'));
    if (process.env.PACKAGES_EXTRA_DIR) candidates.push(...scanRawRoot(process.env.PACKAGES_EXTRA_DIR, 'extra'));
  }

  for (const c of candidates) await loadCandidate(c, opts);
  // Keep assignments for an explicitly disabled Package so re-enabling it does
  // not silently change its configured port. Broken/uninstalled Packages are
  // still pruned from the private registry.
  prunePackagePorts([...packages.values()].filter((p) => ['loaded', 'disabled'].includes(p.status)).map((p) => p.id));
  return listPackages();
}

// ============================================================
// 自檢：node src/packages/loader.mjs --self-test（隔離 tmp 掃描根，不動正式 packages/）
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  const FIX = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-selftest-'));
  const rootA = path.join(tmp, 'a'); const rootB = path.join(tmp, 'b');
  const VALID = 'github.termux-os.fixture.valid';
  const BROKEN = 'github.termux-os.fixture.broken';
  fs.cpSync(path.join(FIX, VALID), path.join(rootA, VALID), { recursive: true });
  fs.cpSync(path.join(FIX, BROKEN), path.join(rootA, BROKEN), { recursive: true });
  fs.cpSync(path.join(FIX, VALID), path.join(rootB, VALID), { recursive: true });           // 重複 id
  fs.cpSync(path.join(FIX, VALID), path.join(rootB, 'wrong-dirname'), { recursive: true }); // 目錄名≠id
  const disabledDir = path.join(rootB, 'github.termux-os.fixture.disabled');
  fs.cpSync(path.join(FIX, VALID), disabledDir, { recursive: true });
  const dm = JSON.parse(fs.readFileSync(path.join(disabledDir, MANIFEST_FILENAME), 'utf8'));
  dm.id = 'github.termux-os.fixture.disabled'; dm.disabled = true;
  fs.writeFileSync(path.join(disabledDir, MANIFEST_FILENAME), JSON.stringify(dm));
  const oldDir = path.join(rootB, 'github.termux-os.fixture.old');
  fs.cpSync(path.join(FIX, VALID), oldDir, { recursive: true });
  const om = JSON.parse(fs.readFileSync(path.join(oldDir, MANIFEST_FILENAME), 'utf8'));
  om.id = 'github.termux-os.fixture.old'; om.compatibility = { framework: '>=9.9.9' };
  fs.writeFileSync(path.join(oldDir, MANIFEST_FILENAME), JSON.stringify(om));

  await loadPackages({ roots: [rootA, rootB], frameworkVersion: '0.1.0', log: () => {} });
  const st = Object.fromEntries(listPackages().map((p) => [p.id, p]));

  t('valid package loaded', st[VALID]?.status === 'loaded');
  t('valid action registered', getAction('fixture.echo')?.package === VALID);
  t('valid route dispatchable', typeof dispatchPackageRoute(VALID, 'GET', '/ping') === 'function');
  t('valid WebSocket route dispatchable', typeof dispatchPackageWebSocket(VALID, '/stream') === 'function');
  t('broken package failed with error', st[BROKEN]?.status === 'failed' && /register failed/.test(st[BROKEN].error));
  t('framework survives broken package', listPackages().length >= 4); // 隔離：其他 Package 照常入表
  t('duplicate package rejected naming both dirs', /duplicate package id/.test(st[`${VALID}@root`]?.error ?? '')
    && (st[`${VALID}@root`]?.error ?? '').includes(rootA) && (st[`${VALID}@root`]?.error ?? '').includes(rootB));
  t('dirname mismatch rejected', /must equal package id/.test(st['wrong-dirname']?.error ?? ''));
  t('disabled package not loaded', st['github.termux-os.fixture.disabled']?.status === 'disabled');
  t('incompatible package detected', st['github.termux-os.fixture.old']?.status === 'incompatible');

  // ---- Installed Root（022）：active.json→versions/<v>；壞 active/缺版本目錄=failed 不拖垮 ----
  const inst = path.join(tmp, 'installed');
  const INSTID = 'github.termux-os.fixture.installed';
  const put = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  fs.cpSync(path.join(FIX, VALID), path.join(inst, INSTID, 'versions/0.1.0'), { recursive: true });
  const im = JSON.parse(fs.readFileSync(path.join(inst, INSTID, 'versions/0.1.0', MANIFEST_FILENAME), 'utf8'));
  im.id = INSTID; im.components.actions = ['fixture.installed.echo'];
  put(path.join(inst, INSTID, 'versions/0.1.0', MANIFEST_FILENAME), JSON.stringify(im));
  put(path.join(inst, INSTID, 'versions/0.1.0/package.mjs'),
    'export async function register(c){c.actions.register({id:"fixture.installed.echo",name:"E",adapter:"fixture",available:async()=>true,run:async(v)=>v});}');
  put(path.join(inst, INSTID, 'active.json'), JSON.stringify({ schema: 'termux-os.package-active.v1', id: INSTID, active_version: '0.1.0', archive_sha256: 'x', installed_at: 'now' }));
  put(path.join(inst, 'github.termux-os.fixture.badactive/active.json'), '{not json');
  put(path.join(inst, 'github.termux-os.fixture.noversion/active.json'),
    JSON.stringify({ schema: 'termux-os.package-active.v1', id: 'github.termux-os.fixture.noversion', active_version: '9.9.9' }));

  process.env.PACKAGES_INSTALLED_DIR = inst;
  await loadPackages({ frameworkVersion: '0.1.0', log: () => {} }); // 無 roots → 走 installed 路徑
  const st2 = Object.fromEntries(listPackages().map((p) => [p.id, p]));
  t('installed package loaded from active version', st2[INSTID]?.status === 'loaded'
    && st2[INSTID]?.source === 'installed' && st2[INSTID]?.install?.version === '0.1.0'
    && getAction('fixture.installed.echo')?.package === INSTID);
  t('bad active.json failed not fatal', st2['github.termux-os.fixture.badactive']?.status === 'failed'
    && /active.json parse error/.test(st2['github.termux-os.fixture.badactive'].error));
  t('missing version dir explicit error', /versions\/9.9.9/.test(st2['github.termux-os.fixture.noversion']?.error ?? ''));
  delete process.env.PACKAGES_INSTALLED_DIR;

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
