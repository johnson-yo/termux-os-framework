/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: Promptly available authenticated HTTP/WebSocket control routes, asynchronous startup reconciliation,
 *           Package Registry details, local-install safety, and Package HTML compatibility.
 * [POS]: src/server.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { registerAction, listActions, performScene } from './theatre/runtime.mjs';
import { acts, scenes, scripts } from './theatre/catalog.mjs';
import { builtinActions } from './theatre/adapters.mjs';
import * as stage from './stage/manager.mjs';
import {
  serviceDependencyGate, reverseDependencies, dependencyTree, resolveDeclaredDependencies,
  resolveDeclaredDependenciesLocal,
} from './packages/dependency-runtime.mjs';
import {
  loadPackages, loadSinglePackage, unregisterPackage, _getRecord,
  listPackages, getPackage, getPackageWebRoot, dispatchPackageRoute, dispatchPackageWebSocket, listArtifactContracts,
  fetchAssetOnDemand, restoreAssetOnDemand, assetFetchProgress, reconcileAssetFetch, describeAssetVariants,
  setPackageStateChangeHandler,
} from './packages/loader.mjs';
import { resolveInstalledPackages } from './packages/installed-root.mjs';
import { listModelDeclarations } from './packages/model-declarations.mjs';
import { deviceProfile } from './packages/runtime-contract.mjs';
import {
  initDevRuntime, devWatchStart, devWatchStop, devReload, devStatus, listDevWatchers, isDevWatched, devEvents,
} from './packages/dev-runtime.mjs';
import { listCapabilities, describeCapability, setCapabilityBinding, invokeCapability, setCapabilityStateChangeHandler } from './capabilities/resolver.mjs';
import { getState, listStates, setState, setStateChangeHandler } from './state/registry.mjs';
import { listAppsWithState, getAppState, prepareApp } from './apps/coordinator.mjs';
import { collectMetrics } from './system/metrics.mjs';
import { accessInfo } from './system/access.mjs';
import {
  authenticateRequest, browserSessionInfo, clearSessionCookie, configureBrowserAuth, csrfValid, openLocalSession,
  hasPermission, loginBrowser, logoutBrowser, sessionCookie, updateBrowserAuth, verifyBrowserPassword,
} from './system/auth.mjs';
import { adminMenuHasPath, buildAdminMenu } from './system/menu.mjs';
import { configOverrides, migrateConfig, migrationChangedConfig } from './system/config-migrate.mjs';
import { devInjection, devMarkerHtml } from './system/dev-marker.mjs';
import { configureSetupState, isLoopbackAddress, readSetupState, setupDecision, writeSetupState } from './system/setup-state.mjs';
import {
  configurePackageControl, discardPackageUpload, getPackageJob, getPackageUpload,
  packageManagerSnapshot, startPackageJob, storePackageRemoteDownload, storePackageUpload, updatePackageUpload,
} from './system/package-control.mjs';
import {
  DEFAULT_PACKAGE_REGISTRY_URL, configurePackageRegistry, downloadPackageFromRegistry,
  downloadFrameworkFromRegistry, frameworkRegistryInfo, packageRegistryContainsSha256,
  packageRegistryFindByPackageId, packageRegistryInfo,
  packageRegistryDetails, packageRegistrySnapshot, refreshPackageRegistry, packageRegistryFindProviders,
} from './system/package-registry.mjs';
import {
  configureFrameworkUpdateControl, discardFrameworkUpdateUpload, frameworkUpdateSnapshot, getFrameworkUpdateJob,
  getFrameworkUpdateUpload, startFrameworkUpdateJob, storeFrameworkRemoteDownload, storeFrameworkUpdateUpload,
  updateFrameworkUpdateUpload,
} from './system/framework-update-control.mjs';
import { services as stageServices } from './stage/catalog.mjs';
import {
  listLogComponents, readLogSlice, startObservation, setObservationRoot, setObservationServices,
} from './system/observation.mjs';
import { listAssets, describeAsset, getAssetProvider } from './assets/runtime.mjs';
import {
  readRegistry as readAssetRegistry, deactivateAsset, readPayloadLedger, listPayloadRecords,
  listSelectionRecords, payloadIdFor, payloadObjectDir, sharedStore, setPayloadSelection, clearPayloadSelection,
} from './assets/registry.mjs';
import { purgeAssetPayload } from './assets/payload.mjs';
import { importAssetArchive, importAssetArchiveV2 } from './assets/archive.mjs';
import { readDeclarationIndex } from './assets/declarations.mjs';
import { describeAssetV2, listResolvedAssetsV2, resolveAssetV2 } from './assets/resolver.mjs';
import {
  createOperation, readOperation, updateOperation, listOperations, findOperationByIdempotency, reconcileOperations,
} from './assets/transfer/journal.mjs';
import { stagePullFiles, stageFilePath, writePushStream, assertTransferFiles, verifyStagedFiles, pendingBytes, freeSpace } from './assets/transfer/staging.mjs';
import { commitStagedPayload } from './assets/transfer/commit.mjs';
import { deleteImpact, deletePayload, reconcilePayloadDeletions } from './assets/transfer/removal.mjs';
import { validateTransferUrl } from './assets/transfer/http.mjs';
import { migrateV1ToV2 } from './assets/migration.mjs';
import {
  AUTH_PASSWORD_MIN_LENGTH, AUTH_TOKEN_MIN_LENGTH, defaultAuthFile, ensureAuthFile,
  generateAuthToken, writeAuthFile,
} from './system/auth-file.mjs';
import { configurePortRegistry, portRegistrySnapshot } from './system/port-registry.mjs';
import {
  configurePackageSettings, getPackageSetting, isPackageEnabled, packageSettingsSnapshot, setPackageEnabled,
} from './system/package-settings.mjs';
import { updatePackagePortSettings } from './system/port-registry.mjs';
import { sdkGuideSnapshot } from './system/sdk-guide.mjs';
import {
  workspaceSnapshot, createWorkspace, packWorkspace, deleteWorkspace,
} from './system/workspace-view.mjs';
import {
  beginSession, endSession, listSessions, recoverStaleSessions, setSessionRoot,
} from './apps/session.mjs';

// ============================================================
// 根目錄與配置
// ============================================================
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONFIG_PATH = path.resolve(process.env.CONFIG || path.join(ROOT, 'config/defaults/framework.v1.json'));
const CONFIG_DEFAULTS_PATH = path.join(ROOT, 'config/defaults/framework.v1.json');

// 配置永遠不按原樣讀。舊版本的 conf 缺少本版新增的鍵時，過去會在第一次裸取上拋錯，
// 安裝器隨即回滾——落後越多的設備越更新不上去。改為以本版 defaults 為骨架、
// 按鍵路徑把使用者設過的值搬過來，於是「更新」不再依賴「設備上的 conf 有多新」。
function loadConfiguration() {
  const stored = (() => {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
  })();
  // conf 就是 defaults 本身時（開發機直接跑源碼樹）沒有東西要遷移。
  const defaults = JSON.parse(fs.readFileSync(CONFIG_DEFAULTS_PATH, 'utf8'));
  // conf 就是 defaults 本身時（開發機直接跑源碼樹）沒有東西要遷移，也不該回寫。
  if (CONFIG_PATH === CONFIG_DEFAULTS_PATH) return { config: stored ?? defaults, report: null, defaults };
  const { config, report } = migrateConfig(defaults, stored, { defaultsVersion: FRAMEWORK_VERSION_RAW });
  // 也要在「內容沒變、形式不對」時重寫。既有設備的檔案是整份預設被複製進去的，
  // 遷移對它無事可做，於是它會永遠保持那個形態——而那正是讓日後改預設到不了設備的形態。
  const overrides = configOverrides(config, defaults);
  const normalized = stored !== null && JSON.stringify(stored) === JSON.stringify(overrides);
  if (stored === null || migrationChangedConfig(report) || !normalized) {
    // 先留一份原件再覆寫：遷移報告說了什麼，使用者要能對照原始檔案自己核。
    // 檔名記的是「被哪一版遷移之前的樣子」，固定不變，所以重啟不會堆出一串備份。
    if (stored !== null) {
      try { fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.pre-${FRAMEWORK_VERSION_RAW}`); }
      catch { /* 備份失敗不該擋住啟動 */ }
    }
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(overrides, null, 2)}\n`);
    } catch (error) {
      console.warn('[config] 遷移結果無法寫回，本次以記憶體中的配置運行:', error.message);
    }
  }
  return { config, report, defaults };
}
const FRAMEWORK_VERSION_RAW = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
const { config: CFG, report: CONFIG_MIGRATION, defaults: CONFIG_DEFAULTS } = loadConfiguration();

/**
 * 唯一的 conf 寫入口。啟動時 CFG.auth 會被填成真正的 token 與密碼，而 conf 位於 /sdcard——
 * 直接序列化 CFG（先前 LAN 開關與 updateIntegration 都這麼做）等於把管理員憑證寫進共享儲存。
 * 落盤的永遠是「檔案裡本來配置了什麼」，不是「這次運行解析出了什麼」。
 */
function persistConfiguration() {
  // 落盤的是「與本版預設不同的部分」，而不是整個運行期配置：預設值一旦寫進檔案，
  // 日後改預設就再也到不了已安裝的設備，更新邊界檢查也會把它誤判成使用者改動。
  const onDisk = { ...configOverrides(CFG, CONFIG_DEFAULTS), auth: CONFIGURED_AUTH };
  if (!Object.keys(CONFIGURED_AUTH).length) delete onDisk.auth;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(onDisk, null, 2)}\n`);
  return onDisk;
}
const configuredAuth = CFG.auth ?? {};
const CONFIGURED_AUTH = JSON.parse(JSON.stringify(configuredAuth));
const AUTH_FILE = process.env.FRAMEWORK_AUTH_FILE || defaultAuthFile();
const privateAuth = configuredAuth.admin_token && (configuredAuth.admin_password || configuredAuth.admin_token)
  ? {}
  : ensureAuthFile(AUTH_FILE);
CFG.auth = {
  admin_token: process.env.FRAMEWORK_ADMIN_TOKEN || configuredAuth.admin_token || privateAuth.admin_token,
  admin_password: process.env.FRAMEWORK_ADMIN_PASSWORD || configuredAuth.admin_password
    || configuredAuth.admin_token || privateAuth.admin_password,
};
if (!CFG.auth.admin_token || !CFG.auth.admin_password) {
  throw new Error('Framework authentication credentials are unavailable');
}
const credentialSource = process.env.FRAMEWORK_ADMIN_TOKEN || process.env.FRAMEWORK_ADMIN_PASSWORD
  ? 'environment'
  : configuredAuth.admin_token || configuredAuth.admin_password ? 'config' : 'private_file';
const credentialsEditable = credentialSource === 'private_file';

const HOST = process.env.HOST || CFG.server.host;
const PORT = Number(process.env.PORT || CFG.server.port);
const PORT_REGISTRY_PATH = process.env.PORT_REGISTRY_PATH
  || (CONFIG_PATH.startsWith(`${ROOT}${path.sep}`)
    ? path.join(ROOT, '.runtime/ports.v1.json')
    // Keep the registry beside conf/, not inside it: Framework update boundary checks
    // the user-editable conf tree byte-for-byte.
    : path.join(path.dirname(CONFIG_PATH), '..', 'ports.v1.json'));
const AUTH_AUDIT_PATH = process.env.AUTH_AUDIT_PATH || path.join(ROOT, '.runtime/auth/login-failures.v1.jsonl');
// Cookie values are bearer credentials: persist only in Termux private Home, never on shared /sdcard.
const BROWSER_SESSION_PATH = process.env.BROWSER_SESSION_PATH
  || path.join(os.homedir(), '.termux-os', 'browser-sessions.v1.json');
const PACKAGE_CONTROL_ROOT = process.env.PACKAGE_CONTROL_ROOT
  || path.join(path.dirname(CONFIG_PATH), 'package-control');
const PACKAGE_SETTINGS_PATH = process.env.PACKAGE_SETTINGS_PATH
  || path.join(path.dirname(CONFIG_PATH), '..', 'package-settings.v1.json');
// Setup 進度不是使用者的設定，所以不放進 conf/——那棵樹要參與更新邊界比對。
// 用持久根而不是「conf 的上一層」：後者假設了 conf 一定在子目錄裡，一旦不是，
// 狀態檔就會落到共享目錄，讓不相干的兩套安裝互相覆蓋彼此的 Setup 進度。
const SETUP_STATE_PATH = process.env.SETUP_STATE_PATH
  || (process.env.FRAMEWORK_PERSIST
    ? path.join(process.env.FRAMEWORK_PERSIST, 'setup-state.v1.json')
    : path.join(path.dirname(CONFIG_PATH), 'setup-state.v1.json'));
const FRAMEWORK_UPDATE_ROOT = process.env.FRAMEWORK_UPDATE_ROOT
  || path.resolve(path.dirname(CONFIG_PATH), '..', 'updates');
const FRAMEWORK_CONTROL_PATH = process.env.FRAMEWORK_CONTROL_PATH || path.join(os.homedir(), 'framework.sh');
const PACKAGES_INSTALLED_ROOT = process.env.PACKAGES_INSTALLED_DIR
  || path.join(os.homedir(), '.termux-os/packages');
const PACKAGE_REGISTRY_PATH = process.env.PACKAGE_REGISTRY_PATH
  || path.join(os.homedir(), '.termux-os', 'package-registry.v1.json');
const PACKAGE_REGISTRY_URL = process.env.PACKAGE_REGISTRY_URL
  || CFG.integrations?.package_registry?.base_url || DEFAULT_PACKAGE_REGISTRY_URL;
const FRAMEWORK_REGISTRY_REPOSITORY = process.env.FRAMEWORK_REGISTRY_REPOSITORY
  || CFG.integrations?.package_registry?.framework_repository || 'johnson-yo/termux-os-framework';

const FRAMEWORK_VERSION = FRAMEWORK_VERSION_RAW;
const FEATURE_SCHEMA = 'termux-os.framework-features.v1';
const FEATURES = Object.freeze({
  admin_integrity: 1,
  admin_shutdown: 1,
  dev_runtime: 1,
  runtime_truth: 1,
  browser_session: 1,
  csrf: 1,
  admin_menu: 1,
  overview: 1,
  package_manager_web: 1,
  package_jobs: 1,
  sdk_guide: 1,
  package_settings: 1,
  package_registry: 1,
});

configureBrowserAuth({
  password: CFG.auth.admin_password ?? CFG.auth.admin_token,
  apiToken: CFG.auth.admin_token,
  auditPath: AUTH_AUDIT_PATH,
  sessionPath: BROWSER_SESSION_PATH,
});
configurePortRegistry({
  path: PORT_REGISTRY_PATH,
  corePort: PORT,
  reserved: [8796, 8797],
  start: Number(process.env.PACKAGE_PORT_START) || 9000,
  end: Number(process.env.PACKAGE_PORT_END) || 9999,
});
configurePackageSettings({ path: PACKAGE_SETTINGS_PATH });
configureSetupState({ path: SETUP_STATE_PATH, version: FRAMEWORK_VERSION });
// 只活在本次進程內：Setup 走完就沒有用途了，沒有必要持久化。
const SETUP_TOKEN = generateAuthToken();
process.env.PORT_REGISTRY_PATH ||= PORT_REGISTRY_PATH;
configurePackageControl({
  root: PACKAGE_CONTROL_ROOT,
  frameworkRoot: ROOT,
  installedRoot: PACKAGES_INSTALLED_ROOT,
  maxUploadBytes: Number(process.env.PACKAGE_UPLOAD_MAX_BYTES) || 1024 * 1024 * 1024,
});
configurePackageRegistry({
  baseUrl: PACKAGE_REGISTRY_URL,
  snapshotPath: PACKAGE_REGISTRY_PATH,
  timeoutMs: Number(process.env.PACKAGE_REGISTRY_TIMEOUT_MS) || 30000,
  directTimeoutMs: Number(process.env.PACKAGE_REGISTRY_DIRECT_TIMEOUT_MS) || 6000,
});
configureFrameworkUpdateControl({
  root: FRAMEWORK_UPDATE_ROOT,
  frameworkRoot: ROOT,
  controlPath: FRAMEWORK_CONTROL_PATH,
  maxUploadBytes: Number(process.env.FRAMEWORK_UPDATE_UPLOAD_MAX_BYTES) || 1024 * 1024 * 1024,
});

const deployId = () => {
  try { return fs.readFileSync(path.join(ROOT, '.deploy-id'), 'utf8').trim(); }
  catch { return 'dev-local'; }
};

const secretMask = (value) => {
  const raw = String(value ?? '');
  return raw ? `***${raw.slice(-4)}` : '***';
};

const credentialSnapshot = () => ({
  schema: 'termux-os.framework-credentials.v1',
  source: credentialSource,
  editable: credentialsEditable,

  /**
   * 凭证被钉在哪里，以及要动它得改哪两个键。
   *
   * ⚠ 只回答「不能改」是把使用者留在原地：这道守卫对「运维刻意把凭证写进配置」是对的，
   * 对「设备从更早的安装继承来的」就是个没有出口的陷阱——而两者长得一模一样。
   * 一条不说该做什么的拒绝，是披着解释外衣的死路。
   */
  locked_by: credentialsEditable ? null : {
    kind: credentialSource, // 'config'（配置文件里有 auth 段）或 'environment'（进程环境变量）
    path: credentialSource === 'config' ? CONFIG_PATH : null,
    keys: credentialSource === 'config'
      ? ['auth.admin_token', 'auth.admin_password']
      : ['FRAMEWORK_ADMIN_TOKEN', 'FRAMEWORK_ADMIN_PASSWORD'],
  },
  system_key_masked: secretMask(CFG.auth.admin_token),
  system_key_preview: secretMask(CFG.auth.admin_token),
  system_key_length: CFG.auth.admin_token.length,
  system_key_uses: ['Framework API', 'Package-to-Package HTTP API', 'third-party App HTTP API'],
  login_password: {
    configured: Boolean(CFG.auth.admin_password),
    minimum_length: AUTH_PASSWORD_MIN_LENGTH,
  },
  // 这几条是直接显示给使用者看的，所以跟着控制台一起用中文；上面的字段名是契约，不动。
  note: credentialsEditable
    ? 'System Key 默认是遮蔽的。受信任的浏览器会话需要完整值时，用「复制密钥」。'
    : '凭证由 Framework 私有凭证文件之外的地方管理，请改环境变量或配置来源。',
});

// ============================================================
// 響應輔助
// ============================================================
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
};

const redirect = (res, location, headers = {}) => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 靜態文件：全部映射進 rootDir，路徑越界一律 404（/admin 與 /packages/<id>/ 共用）
const serveStatic = (res, rootDir, rel) => {
  const file = path.join(rootDir, path.normalize(rel));
  if (!file.startsWith(rootDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { ok: false, error: 'not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
};

function serveDevHtml(res, webRoot, rel, pkgId) {
  const file = path.join(webRoot, path.normalize(rel));
  if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { ok: false, error: 'not found' });
  }
  let html = injectBrowserSession(fs.readFileSync(file, 'utf8'));
  const inject = devInjection(pkgId, devEvents(pkgId)?.seq ?? 0);
  html = html.includes('</body>') ? html.replace('</body>', `${inject}</body>`) : html + inject;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveDevErrorPage(res, pkgId, ev) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>DEV failed — ${pkgId}</title>
<body style="font:14px/1.7 system-ui;background:#1c1917;color:#e7e5e4;padding:2rem;max-width:52rem;margin:auto">
${devMarkerHtml()}
<div style="background:#b45309;color:#fff;font-weight:600;padding:6px 12px;border-radius:6px">
DEV WORKSPACE — 載入失敗（Framework 本體正常）</div>
<h2 style="color:#fca5a5">${pkgId}</h2>
<pre style="white-space:pre-wrap;background:#292524;padding:1rem;border-radius:8px;color:#fda4af">${
  String(ev.error ?? 'unknown error').replace(/</g, '&lt;')}</pre>
<p>修好 Package 代碼後會自動重載；或手動：<code>./sdk/termux-os-sdk dev reload ${pkgId}</code></p>
<button onclick="location.reload()" style="padding:.5rem 1rem;border-radius:6px;border:0;background:#57534e;color:#fff">Retry Reload</button>
<script>setInterval(function(){fetch('/api/dev/packages/${pkgId}/events').then(function(r){return r.json();})
.then(function(d){if(d.status==='loaded')location.reload();}).catch(function(){});},1500);</script>
</body>`);
}

// 030 Browser Session：Installed Package 是不可变 Release，不为认证迁移重打十个包。
// Host 在返回 HTML 时注入同源 session 请求上下文并隐藏旧 token 输入；Package 原文件与 SHA 不变。
// PWA：/admin 是使用者的日常入口，桌面圖示讓它不必先開瀏覽器再找網址。
// Service Worker 的 scope 只有 /admin/，並且把版本帶進 URL——否則更新後仍會拿到舊版本的 shell。
const uiLanguage = () => (typeof CFG.ui?.language === 'string' && CFG.ui.language ? CFG.ui.language : 'zh-Hans');

/**
 * 控制台外壳的内容指纹，用作 Service Worker 的缓存键。
 *
 * 先前用的是版本号。开发中同一个版本会被反复重新部署，缓存键不变，于是浏览器一直在用
 * 上一次的 JavaScript——界面明明改了，看到的还是旧的，而且清浏览器缓存也没用，
 * 因为 Service Worker 的存储是另一套。指纹跟着文件内容走，改了就一定失效。
 */
const ASSET_REVISION = (() => {
  const hash = crypto.createHash('sha256');
  for (const name of ['style.css', 'session.js', 'app-core.js', 'admin-controls.js', 'app.js', 'i18n.js', 'index.html']) {
    try { hash.update(fs.readFileSync(path.join(ROOT, 'web/admin', name))); } catch { hash.update(name); }
  }
  return hash.digest('hex').slice(0, 12);
})();
const pwaInjection = () => `<link rel="manifest" href="/admin/manifest.webmanifest">
<link rel="icon" href="/admin/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#18212b">
<script src="/admin/i18n.js"></script>
<script>window.__TERMUX_OS_LANGUAGE__=${JSON.stringify(uiLanguage())};</script>
<script>if('serviceWorker'in navigator){window.addEventListener('load',function(){
// updateViaCache:'none' 讓瀏覽器每次都去問這支腳本本身，否則裝成 App 之後可能長期停在舊的一份。
navigator.serviceWorker.register('/admin/sw.js?v=${encodeURIComponent(`${FRAMEWORK_VERSION}-${ASSET_REVISION}`)}',
  {scope:'/admin',updateViaCache:'none'}).then(function(r){
  r.update().catch(function(){});
  // Framework 更新後腳本位址會變，新的 worker 接手時整頁重載一次，
  // 否則使用者會在新的 Framework 上繼續看著上一版的介面。
  var reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',function(){
    if(reloading)return; reloading=true; location.reload();
  });
}).catch(function(){});});}</script>`;

function injectPwa(html) {
  if (html.includes('/admin/manifest.webmanifest')) return html;
  return html.includes('</head>')
    ? html.replace('</head>', `${pwaInjection()}\n</head>`)
    : `${pwaInjection()}\n${html}`;
}

function injectBrowserSession(html) {
  const providerCredential = (tag) => /\bdata-provider-credential(?:\s|=|>)/i.test(tag);
  let out = html.replace(/<input\b[^>]*\bid=["']token["'][^>]*>/gi, (tag) => {
    if (providerCredential(tag)) return tag;
    return tag.replace(/\bvalue=(["'])[^"']*\1/i, 'value=""');
  });
  if (!out.includes('/admin/session.js')) {
    const tag = '<script src="/admin/session.js"></script>';
    out = out.replace(/(<script\b[^>]*\bsrc=(["'])(?:\.\/)?app\.js\2[^>]*>)/i, `${tag}\n$1`);
    if (!out.includes(tag)) out = out.replace('</body>', `${tag}</body>`);
  }
  const compat = `<style>#token:not([data-provider-credential]){display:none!important}</style>
<script>window.TermuxOS.ready.then(function(){
  var t=document.getElementById('token'); if(t&&!t.hasAttribute('data-provider-credential')){
    t.type='hidden';t.value='browser-session';
    document.querySelectorAll('label[for="token"]').forEach(function(l){l.hidden=true;});
    var a=t.closest('.auth');if(a)a.hidden=true;}
  var b=document.getElementById('connect')||document.getElementById('reconnect');if(b)b.click();
});</script>`;
  return out.replace('</body>', `${compat}</body>`);
}

function servePackageHtml(res, webRoot, rel) {
  const file = path.join(webRoot, path.normalize(rel));
  if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { ok: false, error: 'not found' });
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(injectBrowserSession(fs.readFileSync(file, 'utf8')));
}

const ADMIN_FILES = new Map([
  ['/admin/i18n.js', 'i18n.js'],
  ['/admin/manifest.webmanifest', 'manifest.webmanifest'],
  ['/admin/icon.svg', 'icon.svg'],
  ['/admin/sw.js', 'sw.js'],
  ['/admin/setup', 'setup.html'],
  ['/admin/setup.js', 'setup.js'],
  ['/admin/login', 'login.html'],
  ['/admin/login.js', 'login.js'],
  ['/admin/session.js', 'session.js'],
  ['/admin/app-core.js', 'app-core.js'],
  ['/admin/admin-controls.js', 'admin-controls.js'],
  ['/admin/app.js', 'app.js'],
  ['/admin/style.css', 'style.css'],
]);
// Admin 的 HTML 一律帶上 PWA 標頭：使用者的入口只有這一個，不該有「哪一頁能安裝」的差別。
const serveAdminFile = (res, file) => {
  if (!file.endsWith('.html')) return serveStatic(res, path.join(ROOT, 'web/admin'), file);
  const full = path.join(ROOT, 'web/admin', file);
  if (!fs.existsSync(full)) return json(res, 404, { ok: false, error: 'not found' });
  const body = injectPwa(fs.readFileSync(full, 'utf8'));
  res.writeHead(200, { 'Content-Type': MIME['.html'] });
  res.end(body);
};
const authed = (req, permission = 'read') => hasPermission(authenticateRequest(req), permission);

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); } });
});

// Asset payload v2 operation inputs containing URLs/temporary headers stay in
// memory only. The journal stores file metadata and stage identity, so a
// process restart can never expose a bearer header through the disk state.
const v2TransferInputs = new Map();
const v2TransferRuns = new Map();
const v2TransferControllers = new Map();

const v2OperationStage = (operationId) => path.join(sharedStore(), '.staging', operationId);

const v2SafeHeaders = (headers) => headers && typeof headers === 'object' && !Array.isArray(headers)
  ? Object.fromEntries(Object.entries(headers).filter(([key, value]) => typeof key === 'string'
    && typeof value === 'string'))
  : {};

const v2SafeMetadata = (metadata) => metadata && typeof metadata === 'object' && !Array.isArray(metadata)
  ? Object.fromEntries(Object.entries(metadata).filter(([key, value]) => typeof key === 'string'
    && !/token|secret|authorization|cookie|password/i.test(key)
    && (value === null || ['string', 'number', 'boolean'].includes(typeof value))))
  : {};

const v2PublicOperation = (operation) => {
  if (!operation) return null;
  const { stage_root: _stageRoot, ...publicValue } = operation;
  return publicValue;
};

const v2FileIdentity = (files) => assertTransferFiles(files).map((file) =>
  `${file.path}\u0000${file.size}\u0000${file.sha256}`).join('\u0001');

const v2OperationResult = (res, operation, code = 200) => json(res, code, {
  ok: true, operation: v2PublicOperation(operation),
});

const runV2Transfer = async (operationId, { files = null, headers = {} } = {}) => {
  const existingRun = v2TransferRuns.get(operationId);
  if (existingRun) return existingRun;
  const operation = readOperation(operationId);
  if (!operation) return { ok: false, error: 'unknown_operation' };
  // Failed and interrupted pulls remain retryable: their `.part` files are
  // the resume base. Only a completed or explicitly cancelled operation is
  // terminal at the Core API level.
  if (['complete', 'cancelled'].includes(operation.state)) return { ok: true, operation };
  const input = v2TransferInputs.get(operationId) ?? { files, headers: v2SafeHeaders(headers) };
  if (files?.length) input.files = files;
  const controller = new AbortController();
  v2TransferControllers.set(operationId, controller);
  const run = (async () => {
    let current = updateOperation(operationId, { state: 'running', error: null });
    const stageRoot = current.stage_root || v2OperationStage(operationId);
    try {
      const specs = assertTransferFiles(input.files ?? current.files);
      if (v2FileIdentity(specs) !== v2FileIdentity(current.files)) {
        throw Object.assign(new Error('transfer file manifest does not match the journal'), { code: 'transfer_spec_mismatch' });
      }
      const requiredBytes = pendingBytes(specs, stageRoot);
      const available = freeSpace(stageRoot);
      if (available.known && requiredBytes > available.free_bytes) {
        throw Object.assign(new Error(`asset transfer needs ${requiredBytes} bytes, only ${available.free_bytes} are free`), {
          code: 'insufficient_space', need_bytes: requiredBytes, free_bytes: available.free_bytes,
        });
      }
      const bytesByFile = new Map(specs.map((file) => [file.path, 0]));
      for (const file of specs) {
        try {
          const stat = fs.statSync(stageFilePath(stageRoot, file.path));
          if (stat.isFile()) bytesByFile.set(file.path, Math.min(file.size, stat.size));
        } catch { /* no staged prefix yet */ }
      }
      const aggregateBytes = () => [...bytesByFile.values()].reduce((sum, bytes) => sum + bytes, 0);
      // Pull operations require URL material in memory or on this explicit
      // retry call; it is intentionally absent from the persisted journal.
      if (current.type !== 'push' && specs.some((file) => typeof file.url !== 'string' || !file.url)) {
        throw Object.assign(new Error('transfer source URL must be supplied when running this operation'), { code: 'transfer_source_required' });
      }
      const progress = (event) => {
        const bytesDone = Number(event?.bytes);
        if (event?.path && Number.isFinite(bytesDone)) {
          const expected = specs.find((file) => file.path === event.path)?.size ?? bytesDone;
          if (['start', 'retry'].includes(event?.stage) && event?.resumed !== true) bytesByFile.set(event.path, 0);
          bytesByFile.set(event.path, Math.max(bytesByFile.get(event.path) ?? 0, Math.min(bytesDone, expected)));
        }
        const patch = {
          current_file: event?.path ?? null,
          bytes_done: aggregateBytes(),
          stage: event?.stage ?? current.stage,
          resumed: event?.resumed === true || current.resumed === true,
          resume_from_bytes: Number.isFinite(Number(event?.resume_from_bytes)) ? Number(event.resume_from_bytes) : current.resume_from_bytes,
        };
        current = { ...current, ...patch };
        // Do not write one JSON file per network chunk; the final state and
        // coarse progress remain durable while the in-memory API stays live.
        if (event?.stage === 'done' || event?.stage === 'attempt_failed' || Date.now() - Date.parse(current.updated_at) > 500) {
          try { current = updateOperation(operationId, patch); } catch { /* final state reports any durable failure */ }
        }
      };
      const staged = current.type === 'push'
        ? { files: specs, verified: verifyStagedFiles(specs, stageRoot) }
        : await stagePullFiles(specs, stageRoot, { headers: input.headers, signal: controller.signal, onProgress: progress });
      if (!staged.verified?.ok) throw Object.assign(new Error(staged.verified?.detail ?? 'staged payload is invalid'), { code: 'staged_payload_invalid' });
      current = updateOperation(operationId, { state: 'staged', bytes_done: current.bytes_total, stage: 'staged' });
      current = updateOperation(operationId, { state: 'committing', stage: 'committing' });
      if (readOperation(operationId)?.state === 'cancelled') {
        return { ok: false, operation: readOperation(operationId), error: 'cancelled', code: 'cancelled' };
      }
      const expectedGeneration = current.expected_generation == null ? null : current.expected_generation;
      const payloadId = payloadIdFor(specs);
      // This is the last durable write before staging becomes the immutable
      // object. It deliberately keeps only neutral file facts: URLs and
      // temporary headers live in v2TransferInputs and never enter the journal.
      current = updateOperation(operationId, {
        commit_intent: {
          schema: 'termux-os.asset-commit-intent.v2',
          payload_id: payloadId,
          layout: 'object',
          storage_path: payloadObjectDir(payloadId),
          files: specs.map(({ path: relative, size, sha256, role }) => ({
            path: relative, size, sha256, ...(role ? { role } : {}),
          })),
          selection: current.select ? { asset_id: current.asset_id, variant_id: current.variant_id } : null,
          metadata: current.metadata,
          expected_generation: expectedGeneration,
        },
      });
      const committed = commitStagedPayload({
        files: specs,
        stageRoot,
        // `null` means that the caller did not ask for CAS. It must not be
        // converted to generation zero after the Ledger has advanced.
        expectedGeneration: expectedGeneration == null ? undefined : expectedGeneration,
        selection: current.select ? { asset_id: current.asset_id, variant_id: current.variant_id } : null,
        metadata: current.metadata,
      });
      current = updateOperation(operationId, {
        state: 'complete', stage: 'done', bytes_done: current.bytes_total, result: {
          payload_id: committed.payload_id, path: committed.path, reused: committed.reused,
        },
      });
      return { ok: true, operation: current };
      } catch (error) {
      const currentState = readOperation(operationId);
      if (currentState?.state === 'cancelled') {
        return { ok: false, operation: currentState, error: currentState.error ?? 'cancelled', code: 'cancelled' };
      }
      const failed = updateOperation(operationId, {
        state: error?.name === 'AbortError' || controller.signal.aborted ? 'cancelled' : 'failed',
        error: String(error?.message ?? error),
        error_code: error?.code ?? null,
        need_bytes: Number.isFinite(Number(error?.need_bytes)) ? Number(error.need_bytes) : null,
        free_bytes: Number.isFinite(Number(error?.free_bytes)) ? Number(error.free_bytes) : null,
      });
      return { ok: false, operation: failed, error: failed.error, code: failed.error_code };
    } finally {
      v2TransferRuns.delete(operationId);
      v2TransferControllers.delete(operationId);
      v2TransferInputs.delete(operationId);
    }
  })();
  v2TransferRuns.set(operationId, run);
  return run;
};

// A Core restart must expose in-flight work as interrupted, never as a fake
// completed download. Staging remains available for an explicit resume.
reconcileOperations();
reconcilePayloadDeletions();

const streamBodyToFile = (req, destination, maxBytes = 4 * 1024 * 1024 * 1024) => new Promise((resolve, reject) => {
  const output = fs.createWriteStream(destination, { flags: 'wx' });
  let bytes = 0;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    output.destroy();
    reject(error);
  };
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      fail(Object.assign(new Error('asset archive exceeds upload limit'), { code: 'payload_too_large' }));
      req.destroy();
      return;
    }
    if (!output.write(chunk)) req.pause();
  });
  output.on('drain', () => req.resume());
  output.on('error', fail);
  req.on('aborted', () => fail(new Error('asset archive upload aborted')));
  req.on('error', fail);
  req.on('end', () => {
    if (settled) return;
    output.end(() => { settled = true; resolve({ bytes }); });
  });
});

// ============================================================
// Theatre —— Action 註冊與演出路由（017）
// ============================================================
builtinActions.forEach(registerAction);
// android-app 四 Action 與 translate.hymt 三 Action 已遷 packages/（021 Section 2）

const theatreState = async () => ({
  ok: true,
  acts: acts.map((a) => ({
    ...a,
    scenes: a.scenes.map((id) => {
      const s = scenes.find((x) => x.id === id);
      return { ...s, steps: scripts.find((x) => x.id === s.script).steps };
    }),
  })),
  actions: await listActions(),
});

const PERFORM = /^\/api\/theatre\/scenes\/([\w.-]+)\/perform$/;

// ============================================================
// Package Loader（021）—— 必須在 stage reconcile 之前：Package 註冊的 Service 也要被收編/恢復；
// 單 Package 失敗只標 failed，Framework 照常啟動
// ============================================================
setSessionRoot(ROOT);
setObservationRoot(ROOT);
setObservationServices(() => stageServices.map((s) => s.id));
// 029：Dev Runtime 先清殘留（重啟不自動恢復 Dev Mount）再載正式 Packages
initDevRuntime({ frameworkRoot: ROOT, frameworkVersion: FRAMEWORK_VERSION, config: CFG, configPath: CONFIG_PATH, saveConfig: persistConfiguration, log: console.log });
/**
 * Dependency v1：服務啟動前先過依賴門禁。
 *
 * ⚠ 用注入而不是讓 stage 去 import 依賴解析——`capabilities/resolver` 已經 import stage，
 * 反向 import 會構成環（stage 自測裡的頂層 await 一撞就死鎖）。
 * 這裡是唯一知道兩邊都已就緒的地方。
 */
stage.setServiceStartGate((def) => serviceDependencyGate(def, { log: console.log }));
let controlPlaneListening = false;
let startupReconcileQueued = 0;
const requestReconcile = (event) => {
  const kind = String(event?.kind ?? 'state_change');
  const subject = event?.name ?? event?.package_id ?? event?.capability ?? event?.service ?? '';
  if (!controlPlaneListening) {
    startupReconcileQueued += 1;
    return Promise.resolve([]);
  }
  return stage.requestDesiredReconcile(subject ? `${kind}:${subject}` : kind);
};
setStateChangeHandler(requestReconcile);
setPackageStateChangeHandler(requestReconcile);
setCapabilityStateChangeHandler(requestReconcile);
await loadPackages({ frameworkVersion: FRAMEWORK_VERSION, config: CFG, configPath: CONFIG_PATH, saveConfig: persistConfiguration, registryBase: PACKAGE_REGISTRY_URL });
const assetMigration = migrateV1ToV2();
if (assetMigration?.migrated?.length || assetMigration?.orphaned?.length || assetMigration?.missing?.length) {
  console.log(`asset payload migration: migrated=${assetMigration.migrated.length} orphaned=${assetMigration.orphaned.length} missing=${assetMigration.missing.length}`);
}

// 025 §8：Session 只操作 Stage 管的 framework 自有 Service（§8.4 邊界：不碰 Android/Termux/APK/Core）
const sessionDeps = {
  listServices: () => stage.listServices(),
  startService: (id) => stage.startService(id),
  stopService: (id, opts) => stage.stopService(id, opts),
};

/**
 * App 這次要哪些 Service 在跑 = 它自己的 worker + 支撐它 required capability 的 Service。
 * 由 Capability descriptor 反查（`service` 欄位），**不寫死**「翻譯要停、ASR 要開」。
 */
async function sessionRequiredServices(pkg) {
  const ids = new Set(pkg.manifest?.components?.services ?? []);
  for (const capId of pkg.manifest?.session?.required_capabilities ?? []) {
    const d = await describeCapability(capId);
    if (d?.service) ids.add(d.service);
  }
  return [...ids];
}

// ============================================================
// Stage Manager 路由（018）—— 啟動時先 reconcile 現場
// ============================================================
const reconciled = stage.reconcileRuntimeState();
if (reconciled.adopted.length || reconciled.cleared.length) {
  console.log(`stage reconcile: adopted=${JSON.stringify(reconciled.adopted)} cleared=${JSON.stringify(reconciled.cleared)}`);
}
// Package registration emits readiness events, but none may start Package Work
// until Core is actually listening. One startup pass sees the complete latest
// truth, so queued registration events need no second queue or replay loop.
const startupReconciliation = { state: 'scheduled', restored: [], recovered: [], error: null };
async function restoreStartupState() {
  startupReconciliation.state = 'restoring_services';
  startupReconciliation.restored = await stage.restoreDesiredServices();
  if (startupReconciliation.restored.length) {
    console.log(`stage restore: ${JSON.stringify(startupReconciliation.restored.map((r) => ({ id: r.id, ok: r.ok })))}`);
  }
  startupReconciliation.state = 'recovering_sessions';
  startupReconciliation.recovered = await recoverStaleSessions(sessionDeps);
  if (startupReconciliation.recovered.length) {
    console.log(`app sessions recovered: ${JSON.stringify(startupReconciliation.recovered)}`);
  }
  startupReconciliation.state = 'complete';
}

function beginStartupRestore() {
  restoreStartupState().catch((error) => {
    startupReconciliation.state = 'failed';
    startupReconciliation.error = String(error?.message ?? error);
    console.error(`startup reconciliation failed: ${String(error?.stack ?? error)}`);
  });
}

async function restartRunningPackageServices() {
  const statuses = await stage.listServices();
  const ids = statuses.filter((service) => service.package && service.desired === 'running').map((service) => service.id);
  const restarted = [];
  for (const id of ids) {
    const result = await stage.restartService(id);
    if (result.ok) restarted.push(id);
  }
  return restarted;
}

// ============================================================
// Package Setting —— editable port policy and Package-owned lifecycle
// ============================================================
const installedPackageEntry = (id) => resolveInstalledPackages(PACKAGES_INSTALLED_ROOT).entries.find((entry) => entry.id === id) ?? null;

const packageInstallInfo = (entry) => ({
  version: entry.active.active_version,
  previous_version: entry.active.previous_version ?? null,
  archive_sha256: entry.active.archive_sha256 ?? null,
  installed_at: entry.active.installed_at ?? null,
});

function packageSettingsInventory() {
  const inventory = packageManagerSnapshot(listPackages());
  return {
    schema: 'termux-os.package-settings.v1',
    policy: portRegistrySnapshot().policy,
    settings: packageSettingsSnapshot(),
    packages: inventory.packages.map((item) => ({
      ...item,
      setting: getPackageSetting(item.id),
      enabled: isPackageEnabled(item.id) && item.enabled !== false,
    })),
    broken: inventory.broken,
  };
}

async function packageServiceState(id) {
  const record = _getRecord(id);
  const ids = new Set(record?.registered?.services ?? []);
  const statuses = await stage.listServices();
  return statuses.filter((service) => ids.has(service.id)).map((service) => ({
    id: service.id,
    running: service.process?.state === 'running',
    should_run: service.desired === 'running',
  }));
}

async function stopPackageServicesForSetting(id, { preserveDesired }) {
  const services = await packageServiceState(id);
  for (const service of services) {
    await stage.stopService(service.id, { preserveDesired });
  }
  return {
    services: services.map((service) => service.id),
    restart_services: services.filter((service) => service.running || service.should_run).map((service) => service.id),
  };
}

async function loadInstalledPackage(id) {
  const entry = installedPackageEntry(id);
  if (!entry) throw Object.assign(new Error('unknown_package'), { code: 'unknown_package' });
  const record = await loadSinglePackage({
    dir: entry.dir,
    expectId: entry.id,
    source: 'installed',
    install: packageInstallInfo(entry),
  }, {
    frameworkVersion: FRAMEWORK_VERSION,
    config: CFG,
    configPath: CONFIG_PATH,
    log: console.log,
  });
  return record;
}

async function restartPackageForSetting(id) {
  if (!isPackageEnabled(id)) throw Object.assign(new Error('Package is disabled'), { code: 'package_disabled' });
  const current = _getRecord(id);
  if (!current || current.status !== 'loaded') {
    throw Object.assign(new Error('Package is not currently loaded'), { code: 'package_not_loaded' });
  }
  const paused = await stopPackageServicesForSetting(id, { preserveDesired: true });
  await unregisterPackage(id);
  const record = await loadInstalledPackage(id);
  if (record?.status !== 'loaded') {
    throw Object.assign(new Error(record?.error ?? 'Package reload failed'), { code: 'package_reload_failed' });
  }
  const restarted = [];
  for (const service of paused.restart_services) {
    if (record.registered.services.includes(service)) {
      const result = await stage.startService(service);
      if (result.ok) restarted.push(service);
    }
  }
  return { ok: true, action: 'restart', package_id: id, restarted_services: restarted, dropped_sessions: paused.services };
}

async function disablePackageForSetting(id) {
  if (!installedPackageEntry(id)) throw Object.assign(new Error('unknown_package'), { code: 'unknown_package' });
  const current = _getRecord(id);
  const stopped = current ? await stopPackageServicesForSetting(id, { preserveDesired: false }) : { services: [], restart_services: [] };
  if (current) await unregisterPackage(id);
  const setting = setPackageEnabled(id, false);
  // Keep a disabled record in the loader so Applications and Package Setting
  // can show the switch immediately and offer Enable without a Framework restart.
  await loadInstalledPackage(id);
  return { ok: true, action: 'disable', package_id: id, setting, stopped_services: stopped.services };
}

async function enablePackageForSetting(id) {
  const entry = installedPackageEntry(id);
  if (!entry) throw Object.assign(new Error('unknown_package'), { code: 'unknown_package' });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(entry.dir, 'termux-os.package.json'), 'utf8')); } catch {
    throw Object.assign(new Error('Package manifest is unavailable'), { code: 'package_manifest_unavailable' });
  }
  if (manifest.disabled === true) {
    throw Object.assign(new Error('Package Manifest marks this Package disabled'), { code: 'package_manifest_disabled' });
  }
  const current = _getRecord(id);
  if (current?.status === 'loaded' && isPackageEnabled(id)) {
    return { ok: true, action: 'enable', package_id: id, changed: false, started_services: [] };
  }
  if (current) {
    await stopPackageServicesForSetting(id, { preserveDesired: false });
    await unregisterPackage(id);
  }
  setPackageEnabled(id, true);
  const record = await loadInstalledPackage(id);
  if (record?.status !== 'loaded') {
    setPackageEnabled(id, false);
    throw Object.assign(new Error(record?.error ?? 'Package enable failed'), { code: 'package_enable_failed' });
  }
  const started = [];
  for (const service of record.registered.services) {
    const result = await stage.startService(service);
    if (result.ok) started.push(service);
  }
  return { ok: true, action: 'enable', package_id: id, changed: true, started_services: started };
}

/**
 * 030 Section 1：更新成功不能只看端口。这里聚合的都是现有正式真相源，不重新判断 Package 业务健康。
 * 单 Package load failure 仍按 021 隔离，只进入 attention；Framework 自身契约缺失才令 ok=false。
 */
function integrityReport() {
  const pkgs = listPackages();
  const menu = buildAdminMenu({
    packages: pkgs.map((p) => ({ ...p, manifest: getPackage(p.id)?.manifest })),
    permissions: ['read', 'write'],
    developerMode: CFG.developer_mode === true,
  });
  let packageManager;
  try {
    const snapshot = packageManagerSnapshot(pkgs);
    packageManager = {
      ok: snapshot.schema === 'termux-os.package-manager.v1',
      installed: snapshot.packages.length,
      broken: snapshot.broken.length,
      active_job: snapshot.active_job?.id ?? null,
    };
  } catch (error) {
    packageManager = { ok: false, error: String(error?.message ?? error) };
  }
  const checks = {
    auth_entry: { ok: fs.existsSync(path.join(ROOT, 'web/admin/index.html')) },
    navigation: { ok: menu.menu.length === 6, top_level: menu.menu.map((n) => n.title) },
    package_manager: {
      ...packageManager,
      ok: fs.existsSync(path.join(ROOT, 'scripts/package-manager.mjs'))
        && fs.existsSync(path.join(ROOT, 'scripts/package-job.mjs'))
        && packageManager.ok,
    },
    installed_packages: { ok: true, count: pkgs.length,
      loaded: pkgs.filter((p) => p.status === 'loaded').length,
      failed: pkgs.filter((p) => p.status === 'failed').map((p) => p.id) },
    services: { ok: true, registered: stageServices.length },
    desired_restore: {
      ok: startupReconciliation.state !== 'failed',
      state: startupReconciliation.state,
      queued_events: startupReconcileQueued,
      failures: startupReconciliation.restored.filter((r) => r.ok === false)
        .map((r) => ({ id: r.id, error: r.error ?? null })),
      error: startupReconciliation.error,
    },
    runtime_truth: { ok: pkgs.every((p) => p.status !== 'loaded' || p.runtime !== null) },
    persistent_config: { ok: fs.existsSync(CONFIG_PATH), file: path.basename(CONFIG_PATH) },
    framework_build: { ok: deployId() !== 'unknown', deploy_id: deployId(), version: FRAMEWORK_VERSION },
  };
  const core = ['auth_entry', 'navigation', 'package_manager', 'desired_restore',
    'runtime_truth', 'persistent_config', 'framework_build'];
  return {
    ok: core.every((id) => checks[id].ok),
    schema: 'termux-os.framework-integrity.v1',
    feature_schema: FEATURE_SCHEMA,
    features: FEATURES,
    checks,
  };
}

const readJsonFile = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

async function overviewReport() {
  const components = {};
  try { components.resources = { ok: true, value: collectMetrics() }; }
  catch (e) { components.resources = { ok: false, error: String(e?.message ?? e) }; }

  let packages = [];
  try {
    packages = listPackages();
    components.packages = {
      ok: true,
      value: {
        installed: packages.length,
        loaded: packages.filter((p) => p.status === 'loaded').length,
        failed: packages.filter((p) => p.status === 'failed').length,
        degraded: packages.filter((p) => p.status === 'loaded'
          && p.runtime && p.runtime !== 'Ready' && !p.runtime.startsWith('Legacy')).length,
        available_updates: null,
      },
    };
    const typeSummary = (type) => {
      const typed = packages.filter((p) => p.types?.includes(type));
      return {
        installed: typed.length,
        loaded: typed.filter((p) => p.status === 'loaded').length,
        disabled: typed.filter((p) => p.status === 'disabled').length,
        failed: typed.filter((p) => ['failed', 'incompatible'].includes(p.status)).length,
      };
    };
    components.applications = { ok: true, value: typeSummary('app') };
    components.adapters = { ok: true, value: typeSummary('adapter') };
  } catch (e) { components.packages = { ok: false, error: String(e?.message ?? e) }; }

  let services = [];
  try {
    services = await stage.listServices();
    const count = (state) => services.filter((s) => s.process?.state === state).length;
    components.services = {
      ok: true,
      value: {
        total: services.length,
        running: count('running'),
        stopped: count('stopped'),
        failed: services.filter((s) => ['failed', 'exited'].includes(s.process?.state)
          || s.health?.state === 'unhealthy').length,
      },
    };
  } catch (e) { components.services = { ok: false, error: String(e?.message ?? e) }; }

  const updatePath = path.resolve(path.dirname(CONFIG_PATH), '..', 'updates/state.v1.json');
  const update = readJsonFile(updatePath);
  components.framework = {
    ok: true,
    value: {
      health: 'healthy',
      version: FRAMEWORK_VERSION,
      build: deployId(),
      last_update: update,
    },
  };

  const attention = [];
  if (update && !['success'].includes(update.status)) {
    attention.push({ kind: 'update', severity: 'warning', title: 'Recent Framework update needs review',
      detail: `${update.candidate_build ?? 'unknown'}: ${update.status}`, href: '/admin/system/framework-update' });
  }
  for (const p of packages.filter((x) => x.status !== 'loaded' && x.status !== 'disabled')) {
    attention.push({ kind: 'package', severity: 'error', title: p.name ?? p.id,
      detail: p.error ?? p.status, href: '/admin/packages/overview' });
  }
  for (const s of services.filter((x) => ['failed', 'exited'].includes(x.process?.state)
    || x.health?.state === 'unhealthy')) {
    attention.push({ kind: 'service', severity: 'error', title: s.name ?? s.id,
      detail: `${s.process?.state ?? 'unknown'} / ${s.health?.state ?? 'unknown'}`, href: '/admin/services/overview' });
  }
  try {
    for (const w of listDevWatchers()) attention.push({ kind: 'dev', severity: 'info',
      title: `Watching for changes: ${w.package_id}`,
      detail: `${w.watch_mode} — auto-reload is on; this does not change the Package's released/edited state`,
      href: '/admin/system/developer' });
  } catch { /* 独立组件失败不拖垮 Overview */ }
  const free = components.resources?.value?.storage?.sdcard?.free_gb;
  if (Number.isFinite(free) && free < 1) attention.push({ kind: 'storage', severity: 'error',
    title: 'Storage is low', detail: `${free} GB free on /sdcard`, href: '/admin/status/overview' });

  return {
    ok: true,
    schema: 'termux-os.admin-overview.v1',
    generated_at: new Date().toISOString(),
    system: {
      device: CFG.device_name,
      platform: `${process.platform}/${process.arch}`,
      android: process.env.ANDROID_ROOT ? os.release() : null,
      termux_prefix: process.env.PREFIX ?? null,
      node: process.version,
    },
    components,
    attention,
  };
}

const STAGE_CTL = /^\/api\/stage\/services\/([\w.@-]+)\/(start|stop|restart)$/;
const STAGE_LOGS = /^\/api\/stage\/services\/([\w.@-]+)\/logs$/;

const stageRoute = async (req, res, url, query) => {
  if (url === '/api/stage/services' && req.method === 'GET') {
    return json(res, 200, { ok: true, services: await stage.listServices() });
  }
  if (url === '/api/stage/stop-all' && req.method === 'POST') {
    return json(res, 200, await stage.stopAllServices());
  }
  const logs = url.match(STAGE_LOGS);
  if (logs && req.method === 'GET') {
    const lines = stage.readServiceLogs(logs[1], query.get('lines') ?? 100);
    if (lines === null) return json(res, 404, { ok: false, error: 'unknown_service' });
    return json(res, 200, { ok: true, service: logs[1], lines });
  }
  const ctl = url.match(STAGE_CTL);
  if (ctl && req.method === 'POST') {
    // preserve_desired=1（022 Installer Quiesce）：系統性停靠不改用戶意圖，重裝後 desired 恢復照舊
    const result = ctl[2] === 'stop' && query.get('preserve_desired') === '1'
      ? await stage.stopService(ctl[1], { preserveDesired: true })
      : await stage[`${ctl[2]}Service`](ctl[1]);
    return json(res, result.error === 'unknown_service' ? 404 : 200, result);
  }
  return json(res, 404, { ok: false, error: 'not found' });
};

// ============================================================
// 路由
// ============================================================
let shutdownScheduled = false;
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://x');
  // 工作區實例的 id 是 `<包id>@<slug>`，瀏覽器用 encodeURIComponent 送出時 `@` 變成 `%40`，
  // 而路由的 id 字元集裡沒有 `%`——於是「停止掛載」這類請求全部落到 404 not found。
  // 這裡只還原 `@`：id 只由 [\w.@-] 組成，其中唯一會被編碼的就是它。做通用解碼會把
  // `%2F` 變成路徑分隔符，等於讓外部決定命中哪一條路由。
  const url = parsed.pathname.replace(/%40/gi, '@');
  // 本機瀏覽器進入面板時會就地取得一個 Session（見下方 localEntry），所以這裡不是 const。
  let auth = authenticateRequest(req);

  // Browser Session 与 SDK Bearer 分离：login 只接密码；Cookie 不可被 JS 读取，写请求另验 CSRF。
  if (url === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body.password !== 'string') {
      return json(res, 400, { ok: false, error: 'password_required' });
    }
    const result = loginBrowser(body.password, req.socket.remoteAddress);
    if (!result.ok) return json(res, result.status, { ok: false, error: result.error });
    return json(res, 200, {
      ...browserSessionInfo({ kind: 'session', permissions: result.session.permissions, session: result.session }),
      next: '/admin/status/overview',
    }, { 'Set-Cookie': sessionCookie(result.session), 'Cache-Control': 'no-store' });
  }
  if (url === '/api/auth/session' && req.method === 'GET') {
    const info = browserSessionInfo(auth);
    return info
      ? json(res, 200, info, { 'Cache-Control': 'no-store' })
      : json(res, 401, { ok: false, error: 'browser_session_required' }, { 'Cache-Control': 'no-store' });
  }
  if (url === '/api/auth/logout' && req.method === 'POST') {
    if (auth?.kind !== 'session') return json(res, 401, { ok: false, error: 'browser_session_required' });
    if (!csrfValid(req, auth)) return json(res, 403, { ok: false, error: 'csrf_failed' });
    logoutBrowser(auth);
    return json(res, 200, { ok: true }, {
      'Set-Cookie': clearSessionCookie(),
      'Cache-Control': 'no-store',
    });
  }

  // Setup 只回應本機請求，而且只在尚未認領或本版尚未確認時存在。它是唯一會在未登入的情況下
  // 顯示密碼的地方——安裝完成後使用者手上只有這台手機，沒有別的途徑知道系統替他生成了什麼。
  const setupContext = () => ({
    local: isLoopbackAddress(req.socket?.remoteAddress),
    state: readSetupState(),
  });
  if (url === '/api/admin/setup' && req.method === 'GET') {
    const { local, state } = setupContext();
    const decision = setupDecision({ state, local, migrationChanged: Boolean(CONFIG_MIGRATION && migrationChangedConfig(CONFIG_MIGRATION)) });
    if (decision === 'none') return json(res, 404, { ok: false, error: 'setup_not_available' }, { 'Cache-Control': 'no-store' });
    return json(res, 200, {
      ok: true,
      step: decision,
      version: FRAMEWORK_VERSION,
      editable: credentialsEditable,
      setup_token: SETUP_TOKEN,
      password_minimum_length: AUTH_PASSWORD_MIN_LENGTH,
      admin_password: CFG.auth.admin_password,
      system_key: CFG.auth.admin_token,
      // 遷移已經在啟動時發生過了（不然服務起不來），這裡呈現的是它做了什麼，
      // 以及「不要沿用舊配置」這個選項會撤銷掉什麼。
      migration: CONFIG_MIGRATION ? {
        from_schema: CONFIG_MIGRATION.from_schema,
        transplanted: CONFIG_MIGRATION.transplanted,
        defaulted: CONFIG_MIGRATION.defaulted,
        coerced: CONFIG_MIGRATION.coerced,
        kept: CONFIG_MIGRATION.kept,
        has_previous: CONFIG_MIGRATION.transplanted.length > 0 || CONFIG_MIGRATION.kept.length > 0,
      } : null,
    }, { 'Cache-Control': 'no-store' });
  }
  if (url === '/api/admin/setup' && req.method === 'POST') {
    const { local, state } = setupContext();
    const decision = setupDecision({ state, local, migrationChanged: Boolean(CONFIG_MIGRATION && migrationChangedConfig(CONFIG_MIGRATION)) });
    if (decision === 'none') return json(res, 404, { ok: false, error: 'setup_not_available' });
    const body = await readBody(req);
    // 這個端點在未登入時可用，所以不受一般寫入路徑的 CSRF 保護。設備上任何網頁都能對
    // 127.0.0.1 發 POST，但跨來源腳本讀不到 GET 的回應，因此拿不到這個值。
    if (body?.setup_token !== SETUP_TOKEN) return json(res, 403, { ok: false, error: 'setup_token_invalid' });
    const password = body?.password;
    let restartRequired = false;
    if (typeof password === 'string' && password.length > 0) {
      if (!credentialsEditable) return json(res, 409, { ok: false, error: 'credentials_managed_externally' });
      if (password.length < AUTH_PASSWORD_MIN_LENGTH) {
        return json(res, 400, { ok: false, error: 'login_password_too_short', detail: `Login password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters.` });
      }
      const next = writeAuthFile(AUTH_FILE, { admin_password: password });
      CFG.auth.admin_password = next.admin_password;
      updateBrowserAuth({ password: next.admin_password, apiToken: CFG.auth.admin_token, invalidateSessions: true });
    }
    // 不沿用舊配置＝把檔案清成「沒有任何覆蓋項」，重啟後一切走本版預設。
    if (body?.use_previous_config === false) {
      const before = JSON.stringify(configOverrides(CFG, CONFIG_DEFAULTS));
      try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ schema: CONFIG_DEFAULTS.schema }, null, 2)}\n`);
      } catch (error) {
        return json(res, 500, { ok: false, error: 'config_write_failed', detail: String(error?.message ?? error) });
      }
      restartRequired = before !== '{"schema":"' + CONFIG_DEFAULTS.schema + '"}' && before !== '{}';
    }
    writeSetupState({ claimed_at: state.claimed_at ?? new Date().toISOString(), acknowledged_version: FRAMEWORK_VERSION });
    return json(res, 200, { ok: true, restart_required: restartRequired }, { 'Cache-Control': 'no-store' });
  }
  // 所有 API 写操作：Bearer token 自带 write；Browser Session 必须同时有 write + CSRF。
  if (url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!auth) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!hasPermission(auth, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
    if (!csrfValid(req, auth)) return json(res, 403, { ok: false, error: 'csrf_failed' });
  }

  // A controller may share the Termux UID with Core while Android SELinux puts
  // it in another process domain and denies kill(2). Authenticated self-shutdown
  // makes stop/update depend on Framework ownership, not signal permission.
  if (url === '/api/admin/shutdown' && req.method === 'POST') {
    const accepted = !shutdownScheduled;
    shutdownScheduled = true;
    if (accepted) {
      res.once('finish', () => {
        const begin = setTimeout(() => {
          const forced = setTimeout(() => process.exit(0), 2000);
          forced.unref();
          server.close(() => {
            clearTimeout(forced);
            process.exit(0);
          });
        }, 20);
        begin.unref();
      });
    }
    return json(res, 202, {
      ok: true,
      schema: 'termux-os.framework-shutdown.v1',
      state: accepted ? 'accepted' : 'already_scheduled',
      deploy_id: deployId(),
    }, { 'Cache-Control': 'no-store' });
  }

  // 030 Section 4：WebUI 只上传、确认、启动/轮询外部 job；真正生命周期仍唯一进入
  // scripts/package-manager.mjs。worker 脱离本进程，故 install 引发 Framework restart 也不会丢结果。
  const packageControlError = (error) => {
    const code = error?.code ?? 'package_control_failed';
    const status = code === 'upload_too_large' ? 413
      : code.startsWith('unknown_') ? 404
        : ['package_job_active', 'upload_job_active', 'preflight_required', 'confirmation_mismatch',
          'unverified_release_confirmation_required', 'required_by_others', 'dependency_not_in_catalog',
          'local_dependencies_missing', 'invalid_dependency_mode', 'dirty_options_conflict']
          .includes(code) ? 409 : 400;
    return json(res, status, {
      ok: false,
      error: code,
      detail: String(error?.message ?? error),
      // 結構化的引用者清單。⚠ 只給一句 detail，WebUI 就只能把它當字串印出來，
      // 使用者點不進去那個真正該先處理的包。
      ...(error?.required_by ? { required_by: error.required_by } : {}),
      // 依賴計畫要結構化交出去，WebUI 才能列出缺什麼、多大、按什麼順序裝。
      ...(error?.dependencies ? { dependencies: error.dependencies } : {}),
    });
  };
  const packageRegistryError = (error) => {
    const code = error?.code ?? 'registry_unavailable';
    const status = ['registry_unavailable', 'registry_download_failed', 'download_failed', 'registry_upstream_rejected', 'download_fallback_exhausted']
      .includes(code) ? 502
      : ['registry_file_unpinned', 'registry_metadata_mismatch'].includes(code) ? 409
        : code === 'upload_too_large' ? 413 : 400;
    return json(res, status, {
      ok: false,
      error: code,
      detail: String(error?.message ?? error),
      ...(error?.manual_url ? {
        manual: {
          release_url: error.manual_url,
          source_url: error.source_url ?? null,
          attempts: Array.isArray(error.attempts) ? error.attempts : [],
        },
      } : {}),
    });
  };
  const installDependencyMode = (upload, body = {}) => {
    const requested = body?.dependency_mode == null ? null : String(body.dependency_mode);
    if (requested && !['local_only', 'registry'].includes(requested)) {
      throw Object.assign(new Error('dependency_mode must be local_only or registry'), {
        code: 'invalid_dependency_mode',
      });
    }
    // Checking the unverified-SHA acknowledgement is an explicit local/offline
    // decision. It must not be followed by a Registry lookup or dependency
    // download, even when an old client also sent a conflicting mode.
    if (body?.confirm_unverified === true) {
      if (requested === 'registry') {
        throw Object.assign(new Error('unverified archive acknowledgement requires local_only dependency mode'), {
          code: 'invalid_dependency_mode',
        });
      }
      return 'local_only';
    }
    return requested ?? (upload.install_source === 'registry' ? 'registry' : 'local_only');
  };
  const dependencyPlanForUpload = async (upload, mode = installDependencyMode(upload)) => {
    const declared = upload?.preflight?.dependencies?.requires ?? [];
    if (!declared.length) return null;
    const plan = mode === 'local_only'
      ? await resolveDeclaredDependenciesLocal(declared)
      : resolveDeclaredDependencies(declared,
        { catalog: packageRegistryFindByPackageId, providers: packageRegistryFindProviders });
    return { ...plan, dependency_mode: mode };
  };
  if (url === '/api/admin/credentials' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    // 讓面板知道這次請求是不是來自本機，它才能決定要不要問舊密碼。
    return json(res, 200, { ...credentialSnapshot(), local: isLoopbackAddress(req.socket?.remoteAddress) },
      { 'Cache-Control': 'no-store' });
  }
  if (url === '/api/admin/credentials/system-key' && req.method === 'GET') {
    // A full key is available only for an authenticated Browser Session's explicit Copy action.
    // Bearer API clients receive the masked credential snapshot instead.
    if (auth?.kind !== 'session' || !hasPermission(auth, 'read')) {
      return json(res, 401, { ok: false, error: 'browser_session_required' }, { 'Cache-Control': 'no-store' });
    }
    return json(res, 200, { ok: true, system_key: CFG.auth.admin_token }, { 'Cache-Control': 'no-store' });
  }
  if (url === '/api/admin/credentials/system-key' && req.method === 'POST') {
    if (!credentialsEditable) return json(res, 409, { ok: false, error: 'credentials_managed_externally' });
    const body = await readBody(req);
    const value = body?.generate === true ? generateAuthToken() : body?.value ?? body?.system_key;
    if (typeof value !== 'string' || value.length < AUTH_TOKEN_MIN_LENGTH || /\s/.test(value)) {
      return json(res, 400, { ok: false, error: 'system_key_invalid', detail: `System Key must be at least ${AUTH_TOKEN_MIN_LENGTH} non-whitespace characters.` });
    }
    try {
      const next = writeAuthFile(AUTH_FILE, { admin_token: value });
      CFG.auth.admin_token = next.admin_token;
      updateBrowserAuth({ password: CFG.auth.admin_password, apiToken: next.admin_token });
      const restarted = await restartRunningPackageServices();
      return json(res, 200, { ok: true, ...credentialSnapshot(), restarted_services: restarted }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return json(res, 500, { ok: false, error: 'system_key_update_failed', detail: String(error?.message ?? error) });
    }
  }
  if (url === '/api/admin/credentials/login-password' && req.method === 'POST') {
    if (!credentialsEditable) return json(res, 409, { ok: false, error: 'credentials_managed_externally' });
    const body = await readBody(req);
    const currentPassword = body?.current_password ?? body?.old_password;
    const password = body?.new_password ?? body?.password;
    // 本機不問舊密碼。舊密碼是用來證明「發請求的人就是知道密碼的那個人」，而在這台手機上
    // 進入面板本來就不需要密碼——再問一次只會攔住唯一有權改它的人。別的來源照舊要驗。
    const local = isLoopbackAddress(req.socket?.remoteAddress);
    if (!local) {
      if (typeof currentPassword !== 'string' || !currentPassword) {
        return json(res, 400, { ok: false, error: 'current_password_required' });
      }
      if (!verifyBrowserPassword(currentPassword)) {
        return json(res, 401, { ok: false, error: 'current_password_invalid' });
      }
    }
    if (typeof password !== 'string' || password.length < AUTH_PASSWORD_MIN_LENGTH) {
      return json(res, 400, { ok: false, error: 'login_password_too_short', detail: `Login password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters.` });
    }
    /**
     * ⚠ 不再要求確認欄位。
     *
     * 再輸一次是**遮蔽輸入**的補丁：看不見自己打了什麼，才需要打兩遍來抓錯字。
     * 這個欄位現在是明文的，所以確認保護不了任何東西，只多出一種失敗方式——
     * 而失敗的後果是使用者被關在自己的面板外面。
     */
    try {
      const next = writeAuthFile(AUTH_FILE, { admin_password: password });
      CFG.auth.admin_password = next.admin_password;
      updateBrowserAuth({ password: next.admin_password, apiToken: CFG.auth.admin_token, invalidateSessions: true });
      return json(res, 200, {
        ok: true,
        relogin_required: true,
        message: 'Login password updated. Sign in again with the new password.',
      }, { 'Set-Cookie': clearSessionCookie(), 'Cache-Control': 'no-store' });
    } catch (error) {
      return json(res, 500, { ok: false, error: 'login_password_update_failed', detail: String(error?.message ?? error) });
    }
  }
  if (url === '/api/admin/ports' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, ...portRegistrySnapshot() }, { 'Cache-Control': 'no-store' });
  }
  const packageSettingError = (error) => {
    const code = error?.code ?? 'package_setting_failed';
    const status = ['unknown_package', 'unknown_package_port'].includes(code) ? 404
      : ['package_port_conflict', 'package_job_active', 'package_disabled', 'package_not_loaded', 'package_dev_mounted'].includes(code) ? 409
        : 400;
    return json(res, status, { ok: false, error: code, detail: String(error?.message ?? error) });
  };
  if (url === '/api/admin/package-settings' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      return json(res, 200, { ok: true, ...packageSettingsInventory() }, { 'Cache-Control': 'no-store' });
    } catch (error) { return packageSettingError(error); }
  }
  {
    const save = url.match(/^\/api\/admin\/package-settings\/([\w.@-]+)$/);
    if (save && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (body?.confirm_package_id !== save[1]) {
          throw Object.assign(new Error('Package identity confirmation mismatch'), { code: 'confirmation_mismatch' });
        }
        if (!Array.isArray(body.ports)) {
          throw Object.assign(new Error('ports must be an array'), { code: 'package_ports_required' });
        }
        if (!installedPackageEntry(save[1])) throw Object.assign(new Error('unknown_package'), { code: 'unknown_package' });
        const ports = updatePackagePortSettings(save[1], body.ports);
        return json(res, 200, {
          ok: true,
          package_id: save[1],
          ports,
          restart_required: true,
          message: 'Package port settings saved. Restart the Package to apply them; active sessions will disconnect.',
        }, { 'Cache-Control': 'no-store' });
      } catch (error) { return packageSettingError(error); }
    }
  }
  {
    const action = url.match(/^\/api\/admin\/package-settings\/([\w.@-]+)\/(restart|disable|enable)$/);
    if (action && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (body?.confirm_package_id !== action[1]) {
          throw Object.assign(new Error('Package identity confirmation mismatch'), { code: 'confirmation_mismatch' });
        }
        const result = action[2] === 'restart'
          ? await restartPackageForSetting(action[1])
          : action[2] === 'disable'
            ? await disablePackageForSetting(action[1])
            : await enablePackageForSetting(action[1]);
        return json(res, 200, result, { 'Cache-Control': 'no-store' });
      } catch (error) { return packageSettingError(error); }
    }
  }
  if (url === '/api/admin/restart' && req.method === 'POST') {
    if (!hasPermission(auth, 'write')) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!fs.existsSync(FRAMEWORK_CONTROL_PATH)) {
      return json(res, 500, { ok: false, error: 'controller_missing', detail: FRAMEWORK_CONTROL_PATH });
    }
    // 使用者不該為了讓設定生效而去開 Termux。回應先發出去，重啟才動——
    // 否則進程在寫回應之前就沒了，瀏覽器只會看到連線中斷。
    json(res, 202, { ok: true, restarting: true, note: '控制台會在數秒後恢復；請稍候重新整理。' });
    setTimeout(() => {
      spawn('bash', [FRAMEWORK_CONTROL_PATH, 'restart'], {
        detached: true, stdio: 'ignore', cwd: os.homedir(),
      }).unref();
    }, 250);
    return undefined;
  }
  if (url === '/api/admin/ui' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, language: uiLanguage() }, { 'Cache-Control': 'no-store' });
  }
  if (url === '/api/admin/ui' && req.method === 'POST') {
    if (!hasPermission(auth, 'write')) return json(res, 401, { ok: false, error: 'unauthorized' });
    const body = await readBody(req);
    // 只接受目录里真的存在的语言：接受一个没有目录的代码，等于把界面切成一片回落的原文，
    // 而使用者会以为是自己选错了。
    const language = String(body?.language ?? '');
    const available = fs.existsSync(path.join(ROOT, 'web/admin/i18n', `${language}.json`));
    if (!/^[\w-]+$/.test(language) || (language !== 'zh-Hans' && !available)) {
      return json(res, 400, { ok: false, error: 'language_unavailable', detail: language });
    }
    try {
      CFG.ui = { ...(CFG.ui ?? {}), language };
      persistConfiguration();
    } catch (error) {
      return json(res, 500, { ok: false, error: 'config_write_failed', detail: String(error?.message ?? error) });
    }
    return json(res, 200, { ok: true, language });
  }
  if (url === '/api/admin/network' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, {
      ok: true,
      host: CFG.server?.host ?? '127.0.0.1',
      port: Number(CFG.server?.port) || 8980,
      lan_enabled: (CFG.server?.host ?? '127.0.0.1') === '0.0.0.0',
      // 生效需要重啟：位址與埠都是在進程啟動時綁定的，改配置不會重新 bind。
      restart_required: (CFG.server?.host ?? '127.0.0.1') !== HOST
        || (Number(CFG.server?.port) || 8980) !== PORT,
      running_host: HOST,
      running_port: PORT,
    }, { 'Cache-Control': 'no-store' });
  }
  if (url === '/api/admin/network' && req.method === 'POST') {
    if (!hasPermission(auth, 'write')) return json(res, 401, { ok: false, error: 'unauthorized' });
    const body = await readBody(req);
    const wantsHost = typeof body?.lan_enabled === 'boolean';
    const wantsPort = body?.port !== undefined;
    if (!wantsHost && !wantsPort) {
      return json(res, 400, { ok: false, error: 'lan_enabled_or_port_required' });
    }
    // 只允許這兩個位址。開放監聽是不可逆的暴露——同一 WiFi 下任何設備都能連上管理台——
    // 所以不接受任意位址，避免綁到意料之外的介面。
    const host = wantsHost
      ? (body.lan_enabled ? '0.0.0.0' : '127.0.0.1')
      : (CFG.server?.host ?? '127.0.0.1');
    // 埠會撞，撞了面板就打不開。使用者沒有 shell 可以去改設定檔，所以這件事必須能在
    // 瀏覽器裡做完。特權埠不開放：Termux 不是 root，綁不上去只會變成另一種打不開。
    let port = Number(CFG.server?.port) || 8980;
    if (wantsPort) {
      port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return json(res, 400, { ok: false, error: 'port_invalid',
          detail: 'Port must be an integer between 1024 and 65535.' });
      }
    }
    try {
      CFG.server = { ...(CFG.server ?? {}), host, port };
      persistConfiguration();
    } catch (error) {
      return json(res, 500, { ok: false, error: 'config_write_failed', detail: String(error?.message ?? error) });
    }
    const restartRequired = host !== HOST || port !== PORT;
    return json(res, 200, {
      ok: true, host, port, lan_enabled: host === '0.0.0.0',
      restart_required: restartRequired,
      note: restartRequired ? 'Restart the Framework for the new address to take effect.' : null,
    });
  }
  if (url === '/api/admin/workspaces' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const stages = await stage.listServices();
      return json(res, 200, workspaceSnapshot({ services: stages, config: CFG }), { 'Cache-Control': 'no-store' });
    } catch (error) {
      return json(res, 500, { ok: false, error: 'workspace_view_unavailable', detail: String(error?.message ?? error) });
    }
  }
  if (url === '/api/admin/workspaces' && req.method === 'POST') {
    if (!hasPermission(auth, 'write')) return json(res, 401, { ok: false, error: 'unauthorized' });
    const body = await readBody(req);
    if (!body?.slug) return json(res, 400, { ok: false, error: 'slug_required' });
    if (!body.from_dir && !body.package_id) {
      return json(res, 400, { ok: false, error: 'package_id_required', detail: 'Creating from a template needs the new package id.' });
    }
    const result = createWorkspace({
      slug: body.slug, packageId: body.package_id, type: body.type, name: body.name,
      fromDir: body.from_dir ?? null, config: CFG,
    });
    return json(res, result.ok ? 200 : 400, result);
  }
  {
    const m = url.match(/^\/api\/admin\/workspaces\/([\w.@-]+)\/pack$/);
    if (m && req.method === 'POST') {
      if (!hasPermission(auth, 'write')) return json(res, 401, { ok: false, error: 'unauthorized' });
      const result = packWorkspace({ slug: m[1], config: CFG });
      if (!result.ok) return json(res, 400, result);
      // 產物走瀏覽器下載：框架不碰共享儲存，字節由瀏覽器交給使用者的「下載」目錄。
      try {
        const body = fs.readFileSync(result.archive);
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': body.length,
          'Content-Disposition': `attachment; filename="${result.filename}"`,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } finally {
        fs.rmSync(result.cleanup, { recursive: true, force: true });
      }
      return undefined;
    }
  }
  {
    const m = url.match(/^\/api\/admin\/workspaces\/([\w.@-]+)$/);
    if (m && req.method === 'DELETE') {
      if (!hasPermission(auth, 'write')) return json(res, 401, { ok: false, error: 'unauthorized' });
      const result = deleteWorkspace({ slug: m[1], config: CFG });
      return json(res, result.ok ? 200 : 400, result);
    }
  }
  if (url === '/api/admin/sdk-guide' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      return json(res, 200, sdkGuideSnapshot({
        frameworkRoot: ROOT,
        frameworkVersion: FRAMEWORK_VERSION,
      }), { 'Cache-Control': 'no-store' });
    } catch (error) {
      return json(res, 500, { ok: false, error: 'sdk_guide_unavailable', detail: String(error?.message ?? error) });
    }
  }
  if (url === '/api/admin/package-registry' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, ...packageRegistrySnapshot() }, { 'Cache-Control': 'no-store' });
  }
  if (url === '/api/admin/package-registry/refresh' && req.method === 'POST') {
    try {
      return json(res, 200, { ok: true, ...(await refreshPackageRegistry()) }, { 'Cache-Control': 'no-store' });
    } catch (error) { return packageRegistryError(error); }
  }
  if (url === '/api/admin/package-registry/details' && req.method === 'POST') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...(await packageRegistryDetails(body)) }, { 'Cache-Control': 'no-store' });
    } catch (error) { return packageRegistryError(error); }
  }
  if (url === '/api/admin/package-registry/download' && req.method === 'POST') {
    let upload = null;
    try {
      const body = await readBody(req);
      if (packageManagerSnapshot(listPackages()).active_job) {
        throw Object.assign(new Error('another Package operation is already running'), { code: 'package_job_active' });
      }
      const remote = await downloadPackageFromRegistry(body);
      upload = await storePackageRemoteDownload(remote.response, remote.filename, {
        expectedSize: remote.expected_size,
        expectedSha256: remote.expected_sha256,
        origin: remote.origin,
      });
      const job = startPackageJob('check', { upload_id: upload.id });
      const current = updatePackageUpload(upload.id, { job_id: job.id });
      return json(res, 202, { ok: true, registry: { project: remote.project, version: remote.version, file: remote.file }, upload: current, job });
    } catch (error) {
      if (upload?.id) {
        try { discardPackageUpload(upload.id); } catch { /* Preserve the original registry error. */ }
      }
      if (error?.code === 'package_job_active') return packageControlError(error);
      return packageRegistryError(error);
    }
  }
  if (url === '/api/admin/package-manager' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const snapshot = packageManagerSnapshot(listPackages());
      const packages = snapshot.packages.map((item) => ({
        ...item,
        // Core resolves the exact installable archive; the WebUI must not repeat catalog policy.
        registry_update: packageRegistryInfo({ packageId: item.id, currentVersion: item.version }),
      }));
      return json(res, 200, {
        ok: true,
        ...snapshot,
        packages,
        uploads: snapshot.uploads.map((upload) => ({
          ...upload,
          // This is a cached, pure lookup only; it never refreshes the Registry.
          // If the user acknowledges an unverified local archive in the install
          // POST, that route short-circuits before this lookup altogether.
          registry_verified: packageRegistryContainsSha256(upload.sha256),
          dependency_mode: upload.install_source === 'registry' ? 'registry' : 'local_only',
          // Historical uploads are part of the health-check input. Resolve a
          // dependency plan only for the selected upload; resolving every old
          // plan here makes inventory latency grow with retained history.
          dependencies: null,
        })),
        registry: packageRegistrySnapshot(),
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: 'package_inventory_failed', detail: String(error?.message ?? error) });
    }
  }
  if (url === '/api/admin/package-manager/uploads' && req.method === 'POST') {
    try {
      const upload = await storePackageUpload(req, req.headers['x-filename']);
      const job = startPackageJob('check', { upload_id: upload.id });
      const current = updatePackageUpload(upload.id, { job_id: job.id });
      return json(res, 202, { ok: true, upload: current, job });
    } catch (error) { return packageControlError(error); }
  }
  {
    const m = url.match(/^\/api\/admin\/package-manager\/uploads\/([\w.@-]+)$/);
    if (m && req.method === 'DELETE') {
      try {
        return discardPackageUpload(m[1])
          ? json(res, 200, { ok: true })
          : json(res, 404, { ok: false, error: 'unknown_upload' });
      } catch (error) { return packageControlError(error); }
    }
  }
  {
    const m = url.match(/^\/api\/admin\/package-manager\/uploads\/([\w.@-]+)\/dependencies$/);
    if (m && req.method === 'GET') {
      if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
      try {
        const upload = getPackageUpload(m[1]);
        if (!upload) throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
        const requested = parsed.searchParams.get('dependency_mode');
        const dependencyMode = installDependencyMode(upload, requested === null ? {} : { dependency_mode: requested });
        return json(res, 200, {
          ok: true,
          upload_id: upload.id,
          dependency_mode: dependencyMode,
          dependencies: await dependencyPlanForUpload(upload, dependencyMode),
        }, { 'Cache-Control': 'no-store' });
      } catch (error) { return packageControlError(error); }
    }
  }
  {
    const m = url.match(/^\/api\/admin\/package-manager\/uploads\/([\w.@-]+)\/(check|install)$/);
    if (m && req.method === 'POST') {
      try {
        const upload = getPackageUpload(m[1]);
        if (!upload) throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
        // 依賴在前、目標在後的安裝順序。只有 install 會用到它。
        const installOrder = [];
        let installOptions = null;
        if (m[2] === 'install') {
          const body = await readBody(req);
          if (!upload.preflight?.ok || upload.status !== 'preflight_passed') {
            throw Object.assign(new Error('successful preflight required before install'), { code: 'preflight_required' });
          }
          if (body?.confirm_sha256 !== upload.sha256) {
            throw Object.assign(new Error('confirmed Release SHA does not match upload'), { code: 'confirmation_mismatch' });
          }
          const dependencyMode = installDependencyMode(upload, body);
          if (dependencyMode === 'local_only'
            && body?.confirm_unverified !== true
            && !packageRegistryContainsSha256(upload.sha256)) {
            throw Object.assign(new Error('local archive installation requires explicit acknowledgement of the archive SHA-256'), {
              code: 'unverified_release_confirmation_required',
            });
          }
          if (dependencyMode === 'registry'
            && !packageRegistryContainsSha256(upload.sha256)
            && body?.confirm_unverified !== true) {
            throw Object.assign(new Error('this archive is not present in the verified Registry catalog; explicit acknowledgement is required'), {
              code: 'unverified_release_confirmation_required',
            });
          }
          /**
           * Dependency v1 安裝預檢。⛔ 依賴補不齊就不裝。
           *
           * 判據刻意**不是**「依賴 ready 了嗎」——提供方多半要等安裝完才起得來，
           * 那樣沒有任何包裝得上。判據是「缺的那些在 Catalog 裡拿得到嗎」：
           * 拿得到就報出下載量與安裝順序讓使用者確認，拿不到就現在拒絕。
           * 裝一個永遠補不齊依賴的包，比不裝更難查。
           */
          const declared = upload.preflight?.dependencies?.requires ?? [];
          if (declared.length) {
            const plan = await dependencyPlanForUpload(upload, dependencyMode);
            if (dependencyMode === 'local_only' && !plan.installable) {
              const blocked = (plan.blocked ?? []).filter((node) => node.required !== false);
              throw Object.assign(
                new Error(`required dependencies are not ready locally: ${blocked.map((node) => node.id).join(', ')}`),
                { code: 'local_dependencies_missing', dependencies: plan },
              );
            }
            if (dependencyMode === 'registry' && !plan.installable) {
              throw Object.assign(
                new Error(`missing from the Registry catalog: ${plan.missing_from_catalog.map((n) => n.id).join(', ')}`),
                { code: 'dependency_not_in_catalog', dependencies: plan },
              );
            }
            /**
             * ⭐ 缺的依賴**一起裝**，不是留給使用者自己去補。
             *
             * 只報出「你還缺什麼」而不動手，等於把一次意圖拆成幾次操作；中間任何一次
             * 沒做，結果就是一個裝上了卻不能用的包——正是這套機制要消滅的狀態。
             *
             * ⚠ 只補**必需且 Catalog 拿得到**的缺口。可選依賴照 opkg 的 `Suggests` 辦：
             * 列出來，不預裝——它存在的意義是讓人知道有這東西，不是替人決定。
             */
            for (const item of plan.supply ?? []) {
              const remote = await downloadPackageFromRegistry({
                source: item.source, repository: item.repository,
                version: item.version, kind: item.kind, file: item.file,
              });
              const stored = await storePackageRemoteDownload(remote.response, remote.filename, {
                expectedSize: remote.expected_size,
                expectedSha256: remote.expected_sha256,
                origin: remote.origin,
              });
              installOrder.push(stored.id);
            }
          }
          const preserveDirty = body?.preserve_dirty === true;
          const forceDirty = body?.force_dirty === true;
          if (preserveDirty && forceDirty) {
            throw Object.assign(new Error('choose either dirty backup or force discard, not both'), {
              code: 'dirty_options_conflict',
            });
          }
          installOptions = preserveDirty ? { preserve_dirty: true }
            : forceDirty ? { force_dirty: true } : null;
        }
        installOrder.push(upload.id);
        const target = m[2] === 'install' && installOrder.length > 1
          ? { upload_ids: installOrder }
          : { upload_id: upload.id };
        if (installOptions) target.options = installOptions;
        const job = startPackageJob(m[2], target);
        const current = updatePackageUpload(upload.id, { job_id: job.id });
        return json(res, 202, { ok: true, upload: current, job });
      } catch (error) { return packageControlError(error); }
    }
  }
  {
    const m = url.match(/^\/api\/admin\/package-manager\/packages\/([\w.@-]+)\/(rollback|uninstall)$/);
    if (m && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const item = packageManagerSnapshot(listPackages()).packages.find((p) => p.id === m[1]);
        if (!item) throw Object.assign(new Error('unknown_package'), { code: 'unknown_package' });
        if (body?.confirm_package_id !== item.id
          || (m[2] === 'rollback' && body?.confirm_previous_version !== item.previous_version)) {
          throw Object.assign(new Error('Package identity/version confirmation mismatch'), { code: 'confirmation_mismatch' });
        }
        if (m[2] === 'rollback' && !item.previous_version) {
          throw Object.assign(new Error('Package has no previous version'), { code: 'preflight_required' });
        }
        /**
         * ⛔ 被別人依賴的東西不許卸。⚠ 必須**指名道姓**列出引用者——
         * 只說「有人依賴它」，使用者無從判斷是該先卸那個包還是這次操作本身就是誤點。
         *
         * 一個 Asset 包同時是 Package 也是 Asset 提供方，兩種引用都要查：
         * 只查一種會讓「沒人依賴」這個答案在另一半上是錯的。
         */
        if (m[2] === 'uninstall') {
          const byPackage = reverseDependencies(item.id);
          const assetIds = (getPackage(item.id)?.manifest?.assets?.provides ?? [])
            .map((asset) => asset?.id).filter(Boolean);
          const byAsset = assetIds.flatMap((assetId) => reverseDependencies(assetId, { kind: 'asset' })
            .map((user) => ({ ...user, via_asset: assetId })));
          const users = [...byPackage, ...byAsset];
          if (users.length) {
            throw Object.assign(
              new Error(`still required by: ${users.map((u) => u.id).join(', ')}`),
              { code: 'required_by_others', required_by: users },
            );
          }
        }
        const job = startPackageJob(m[2], { package_id: item.id });
        return json(res, 202, { ok: true, job });
      } catch (error) { return packageControlError(error); }
    }
  }
  {
    const m = url.match(/^\/api\/admin\/package-manager\/jobs\/([\w.@-]+)$/);
    if (m && req.method === 'GET') {
      if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
      const job = getPackageJob(m[1]);
      return job ? json(res, 200, { ok: true, job }) : json(res, 404, { ok: false, error: 'unknown_job' });
    }
  }

  // 030 Section 6：WebUI 只保存 candidate、确认身份并启动 detached observer worker；真正 preflight/
  // update/rollback 始终在目标机唯一 framework.sh 内执行，state/history/边界也由该引擎写入。
  const frameworkUpdateError = (error) => {
    const code = error?.code ?? 'framework_update_control_failed';
    const status = code.startsWith('unknown_') ? 404
      : ['framework_update_job_active', 'framework_update_active', 'preflight_required', 'confirmation_mismatch']
        .includes(code) ? 409
        : ['registry_unavailable', 'registry_download_failed', 'download_failed', 'download_checksum_mismatch',
          'download_fallback_exhausted',
          'download_size_mismatch'].includes(code) ? 502 : 400;
    return json(res, status, {
      ok: false,
      error: code,
      detail: String(error?.message ?? error),
      ...(error?.manual_url ? {
        manual: {
          release_url: error.manual_url,
          source_url: error.source_url ?? null,
          attempts: Array.isArray(error.attempts) ? error.attempts : [],
        },
      } : {}),
    });
  };
  if (url === '/api/admin/framework-update' && req.method === 'GET') {
    if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, {
      ...frameworkUpdateSnapshot({
        currentBuild: deployId(),
        registry: frameworkRegistryInfo({ repository: FRAMEWORK_REGISTRY_REPOSITORY, currentVersion: FRAMEWORK_VERSION }),
      }),
      // 掛載中的 Dev Runtime 會擋下更新。頁面要能就地把它們停掉，
      // 否則使用者只會看到一句「先去停止挂载」卻沒有可點的地方。
      dev_watchers: listDevWatchers().map((w) => ({
        package_id: w.package_id, version_dir: w.version_dir,
      })),
    });
  }
  if (url === '/api/admin/framework-update/registry' && req.method === 'POST') {
    let upload = null;
    try {
      const body = await readBody(req);
      const info = frameworkRegistryInfo({ repository: FRAMEWORK_REGISTRY_REPOSITORY, currentVersion: FRAMEWORK_VERSION });
      // 版本由呼叫方指定，而不是硬綁 latest。「已是最新」不等於「無事可做」：
      // 檔案損壞要能重裝當前版本，出問題要能裝回指定的舊版，而 last-good 只有一格。
      const wanted = typeof body?.version === 'string' && body.version ? body.version : info.latest_version;
      const entry = (info.versions ?? []).find((item) => item.version === wanted);
      const selection = entry?.selection ?? (wanted === info.latest_version ? info.selection : null);
      if (!info.available || !selection) {
        throw Object.assign(new Error(`no verified Framework archive for ${wanted ?? 'latest'}`), { code: 'framework_update_not_available' });
      }
      // 確認值必須等於**請求的**版本：這道閘門是防誤點，不是防舊版。
      if (body?.confirm_version !== wanted) {
        throw Object.assign(new Error('confirmed Framework version does not match the requested one'), { code: 'confirmation_mismatch' });
      }
      const remote = await downloadFrameworkFromRegistry(selection);
      upload = await storeFrameworkRemoteDownload(remote.response, remote.filename, {
        expectedSize: remote.expected_size,
        expectedSha256: remote.expected_sha256,
        version: selection.version,
        origin: remote.origin,
      });
      const job = startFrameworkUpdateJob('registry_upgrade', { upload_id: upload.id, version: selection.version });
      const current = updateFrameworkUpdateUpload(upload.id, { job_id: job.id });
      return json(res, 202, { ok: true, registry: { project: remote.project, version: remote.version, file: remote.file }, upload: current, job });
    } catch (error) {
      if (upload?.id) { try { discardFrameworkUpdateUpload(upload.id); } catch { /* Preserve original error. */ } }
      return frameworkUpdateError(error);
    }
  }
  if (url === '/api/admin/framework-update/uploads' && req.method === 'POST') {
    try {
      const upload = await storeFrameworkUpdateUpload(req, req.headers['x-filename']);
      return json(res, 201, { ok: true, upload });
    } catch (error) { return frameworkUpdateError(error); }
  }
  {
    const m = url.match(/^\/api\/admin\/framework-update\/uploads\/([\w.-]+)\/(preflight|update)$/);
    if (m && req.method === 'POST') {
      try {
        const upload = getFrameworkUpdateUpload(m[1]);
        if (!upload) throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
        if (m[2] === 'update') {
          const body = await readBody(req);
          if (body?.confirm_sha256 !== upload.sha256) {
            throw Object.assign(new Error('confirmed candidate SHA does not match upload'), { code: 'confirmation_mismatch' });
          }
        }
        const job = startFrameworkUpdateJob(m[2], { upload_id: upload.id });
        return json(res, 202, { ok: true, job });
      } catch (error) { return frameworkUpdateError(error); }
    }
  }
  {
    const m = url.match(/^\/api\/admin\/framework-update\/jobs\/([\w.-]+)$/);
    if (m && req.method === 'GET') {
      if (!hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
      const job = getFrameworkUpdateJob(m[1]);
      return job ? json(res, 200, { ok: true, job }) : json(res, 404, { ok: false, error: 'unknown_job' });
    }
  }
  if (url === '/api/admin/framework-update/rollback' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const snapshot = frameworkUpdateSnapshot({ currentBuild: deployId() });
      const lastGood = snapshot.last_good?.build;
      if (!lastGood || body?.confirm_last_good_build !== lastGood) {
        throw Object.assign(new Error('confirmed last-good build does not match current backup'), { code: 'confirmation_mismatch' });
      }
      const job = startFrameworkUpdateJob('rollback');
      return json(res, 202, { ok: true, job });
    } catch (error) { return frameworkUpdateError(error); }
  }

  // System Overview（021 §13）——core 可直接取的指標；GPU/NPU 無可靠數據只報存在性，不猜百分比
  if (url === '/api/system/metrics' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, metrics: collectMetrics() });
  }

  // App Coordinator API（021 §11）——打開 App 前的依賴檢查/同意啟動/就緒輪詢
  if (url === '/api/apps' || url.startsWith('/api/apps/')) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (url === '/api/apps' && req.method === 'GET') {
      return json(res, 200, { ok: true, apps: await listAppsWithState() });
    }
    // App Session（025 §8）——臨時只留 App 要的 Service，結束恢復原樣；Desired State 全程不動。
    // 必須在下面的 /api/apps/<id>(/prepare) 匹配**之前**：那條 regex 匹配不到就直接 404 了
    if (url === '/api/apps/sessions' && req.method === 'GET') {
      return json(res, 200, { ok: true, sessions: listSessions() });
    }
    const ms = url.match(/^\/api\/apps\/([\w.-]+)\/session\/(start|stop)$/);
    if (ms && req.method === 'POST') {
      const [, appPkgId, op] = ms;
      const pkg = getPackage(appPkgId);
      if (!pkg || pkg.status !== 'loaded') return json(res, 404, { ok: false, error: 'unknown_package' });
      const spec = pkg.manifest?.session;
      if (!spec) return json(res, 400, { ok: false, error: 'package declares no session' });
      if (op === 'start') {
        const required = await sessionRequiredServices(pkg);
        const sn = await beginSession(appPkgId, { ...spec, required_services: required }, sessionDeps);
        return json(res, 200, { ok: true, session: sn });
      }
      const open = listSessions().filter((x) => x.app === appPkgId && x.state === 'active');
      if (!open.length) return json(res, 200, { ok: true, changed: false, note: 'no active session' });
      const ended = [];
      for (const x of open) ended.push(await endSession(x.session_id, sessionDeps));
      return json(res, 200, { ok: true, changed: true, sessions: ended });
    }
    const m = url.match(/^\/api\/apps\/([\w.-]+)(\/prepare)?$/);
    if (!m) return json(res, 404, { ok: false, error: 'not found' });
    const [, appId, isPrepare] = m;
    if (!isPrepare && req.method === 'GET') {
      const a = await getAppState(appId);
      return a ? json(res, 200, { ok: true, app: a }) : json(res, 404, { ok: false, error: 'unknown_app' });
    }
    if (isPrepare && req.method === 'POST') {
      const body = await readBody(req);
      const r = await prepareApp(appId, { approveStart: body?.approve_start === true });
      return json(res, r.error === 'unknown_app' ? 404 : 200, r);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  // 狀態總線（054）——第三種機制：Capability 說「誰能做」，state 說「此刻是什麼」。
  // 寫入只允許擁有者（System Key + 名字的登記人），讀取自由；因此值有 1 KB 硬上限，
  // 且不得承載任何憑證/路徑/字節——高頻或不許丟的資料一律走 feed。
  if (url === '/api/states' || url.startsWith('/api/states/')) {
    if (url === '/api/states' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...await listStates() });
    }
    if (url === '/api/states' && req.method === 'POST') {
      if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const body = await readBody(req);
      if (!body?.name) return json(res, 400, { ok: false, error: 'name required' });
      if (!('value' in body)) return json(res, 400, { ok: false, error: 'value required' });
      try {
        const entry = setState(body.name, body.value, { package: body.package ?? null });
        return json(res, 200, { ok: true, state: await getState(entry.name) });
      } catch (e) {
        const code = e?.code === 'unknown_state' ? 404 : e?.code === 'not_owner' ? 403 : 400;
        return json(res, code, { ok: false, error: e?.code ?? 'invalid_state_write', reason: String(e?.message ?? e) });
      }
    }
    const one = url.match(/^\/api\/states\/([a-z0-9._]+)$/);
    if (one && req.method === 'GET') {
      const state = await getState(one[1]);
      return json(res, state.known ? 200 : 404, { ok: state.known, state });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  // Capability / Provider API（021 §9）——App 只認 Capability，綁定可換；feed 不走 invoke
  if (url === '/api/capabilities' || url.startsWith('/api/capabilities/')) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (url === '/api/capabilities' && req.method === 'GET') {
      return json(res, 200, { ok: true, capabilities: await listCapabilities() });
    }
    const m = url.match(/^\/api\/capabilities\/([\w.-]+)(?:\/(bind|invoke))?$/);
    if (!m) return json(res, 404, { ok: false, error: 'not found' });
    const [, capId, op] = m;
    if (!op && req.method === 'GET') return json(res, 200, await describeCapability(capId));
    if (op === 'bind' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.provider) return json(res, 400, { ok: false, error: 'provider required' });
      const r = setCapabilityBinding(capId, String(body.provider));
      return json(res, r.ok ? 200 : 400, r);
    }
    if (op === 'invoke' && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: 'invalid json' });
      return json(res, 200, await invokeCapability(capId, body.input ?? ''));
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  // Package 目錄與命名空間 API（021）——列表/詳情歸 Core，/api/packages/<id>/<sub> 轉發給 Package 自己的路由
  if (url === '/api/packages' || url.startsWith('/api/packages/')) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (url === '/api/packages/model-declarations' && req.method === 'GET') {
      return json(res, 200, listModelDeclarations());
    }
    if (url === '/api/packages' && req.method === 'GET') {
      return json(res, 200, { ok: true, framework_version: FRAMEWORK_VERSION, packages: listPackages() });
    }
    const m = url.match(/^\/api\/packages\/([\w.@-]+)(\/.*)?$/);
    if (!m) return json(res, 404, { ok: false, error: 'not found' });
    const [, pkgId, sub] = m;
    /**
     * Dependency v1 的 doctor 口：整棵依賴樹、每一項卡在哪一級、拓撲安裝順序、
     * 以及誰在反向依賴這個包（卸載前要看的那個問題）。
     *
     * ⚠ 走 Core 自己的路由而不是轉發給 Package——依賴是**框架對這個包的判斷**，
     * 讓包自己回答等於問嫌疑人自己有沒有罪。
     */
    if (sub === '/dependencies') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
      const record = getPackage(pkgId);
      if (!record?.manifest) return json(res, 404, { ok: false, error: 'unknown_package' });
      const tree = await dependencyTree(record.manifest, (id) => getPackage(id)?.manifest ?? null);
      return json(res, 200, {
        ok: true,
        package: pkgId,
        dependencies: tree,
        required_by: reverseDependencies(pkgId),
      });
    }
    if (!sub || sub === '/') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
      const p = getPackage(pkgId);
      return p ? json(res, 200, { ok: true, package: p }) : json(res, 404, { ok: false, error: 'unknown_package' });
    }
    const handler = dispatchPackageRoute(pkgId, req.method, sub);
    if (!handler) {
      return json(res, 404, { ok: false, error: getPackage(pkgId) ? 'unknown_package_route' : 'unknown_package' });
    }
    try {
      return await handler(req, res, {
        json,
        query: parsed.searchParams,
        readBody: () => readBody(req),
        packageId: pkgId,
        auth,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  }


  /**
   * Asset payload lifecycle v2. This route is intentionally before the v1
   * compatibility matcher below. Declarations are derived from Installed
   * Root manifests; all writes operate on Payload Objects/Selections only.
   */
  if (url === '/api/assets/v2' || url.startsWith('/api/assets/v2/')) {
    const authContext = authenticateRequest(req);
    if (!authContext) return json(res, 401, { ok: false, error: 'unauthorized' });
    // Browser Sessions and the legacy system token may inspect v2 facts, but the
    // low-level mutation seam is a Package-to-Core tool boundary.  During the
    // migration window an explicitly opted-in installer principal may retain the
    // old system-token path; normal deployments leave that switch off.
    let v2Write = authContext.kind === 'package'
      && hasPermission(authContext, 'write')
      && authContext.scopes?.includes('assets.write');
    if (v2Write) {
      // The Package id is authenticated by Core, but replaceability means the
      // allowed owner is the current capability binding, never a hard-coded HF
      // Manager id.  A binding change affects new calls only; journaled work is
      // reconciled independently.
      const manager = await describeCapability('termux-os.assets.manager');
      v2Write = manager?.package === authContext.package_id;
    }
    if (authContext.kind === 'token' && process.env.ASSET_V2_ALLOW_SYSTEM_KEY === '1'
      && hasPermission(authContext, 'write')) v2Write = true;
    const apiError = (error, fallback = 'asset_operation_failed') => {
      const code = error?.code ?? fallback;
      const status = code === 'generation_mismatch' ? 409
        : code === 'payload_ledger_corrupt' ? 500
          : code.endsWith('_required') || code.endsWith('_invalid') ? 400 : 409;
      return json(res, status, { ok: false, error: code, detail: String(error?.message ?? error) });
    };
    if (url === '/api/assets/v2' && req.method === 'GET') {
      const index = readDeclarationIndex();
      const ledger = readPayloadLedger();
      if (ledger.error) return json(res, 500, { ok: false, error: 'payload_ledger_corrupt', detail: ledger.error });
      const assets = listResolvedAssetsV2({ index, ledger });
      for (const asset of assets) {
        const provider = getAssetProvider(asset.id);
        asset.runtime_state = provider ? 'loaded' : 'unloaded';
        asset.runtime_package = provider?.package ?? null;
      }
      return json(res, 200, {
        ok: true,
        schema: 'termux-os.asset-inventory.v2',
        generation: ledger.generation,
        declarations: index.declarations,
        declaration_errors: index.errors,
        assets,
        payloads: listPayloadRecords(ledger),
        selections: listSelectionRecords(ledger),
      });
    }
    if (url === '/api/assets/v2/declarations' && req.method === 'GET') {
      const index = readDeclarationIndex();
      return json(res, 200, { ok: true, ...index });
    }
    if (url === '/api/assets/v2/payloads' && req.method === 'GET') {
      const ledger = readPayloadLedger();
      return ledger.error
        ? json(res, 500, { ok: false, error: 'payload_ledger_corrupt', detail: ledger.error })
        : json(res, 200, { ok: true, schema: 'termux-os.asset-payload-ledger.v2', generation: ledger.generation,
          payloads: listPayloadRecords(ledger), selections: listSelectionRecords(ledger) });
    }
      const resolution = url.match(/^\/api\/assets\/v2\/resolutions\/(.+)$/);
      if (resolution && req.method === 'GET') {
      const assetId = decodeURIComponent(resolution[1]);
      const index = readDeclarationIndex();
      const ledger = readPayloadLedger();
      const resolved = resolveAssetV2(assetId, { index, ledger, verify: parsed.searchParams.get('verify') === '1' });
      const status = resolved.registration_state === 'unregistered' ? 404
        : resolved.payload_state === 'ledger_error' ? 500 : 200;
      return json(res, status, { ok: status >= 200 && status < 300, resolution: resolved });
    }
    const operationPathMatch = url.match(/^\/api\/assets\/v2\/operations\/([^/]+)$/);
    if (operationPathMatch && req.method === 'GET') {
      const operation = readOperation(decodeURIComponent(operationPathMatch[1]));
      return operation ? json(res, 200, { ok: true, operation: v2PublicOperation(operation) })
        : json(res, 404, { ok: false, error: 'unknown_operation' });
    }
    const impactMatch = url.match(/^\/api\/assets\/v2\/delete-impact\/(.+)$/);
      if (impactMatch && req.method === 'GET') {
        const payloadId = decodeURIComponent(impactMatch[1]);
        const ledger = readPayloadLedger();
        if (ledger.error) return json(res, 500, { ok: false, error: 'payload_ledger_corrupt', detail: ledger.error });
      const index = readDeclarationIndex();
      const consumerFacts = listModelDeclarations();
      return json(res, 200, { ok: true, impact: deleteImpact(payloadId, {
        ledger, declarations: index.declarations, consumers: consumerFacts.declarations,
        runtime: { loaded: false, source: 'core_observation', errors: consumerFacts.errors },
      }) });
    }
    if (!v2Write) return json(res, 403, { ok: false, error: 'write_permission_required' });

    if (url === '/api/assets/v2/imports' && req.method === 'POST') {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-os-asset-v2-import-'));
      const archivePath = path.join(tempRoot, 'upload.tar.gz');
      try {
        const upload = await streamBodyToFile(req, archivePath,
          Number(process.env.ASSET_ARCHIVE_MAX_BYTES) || 4 * 1024 * 1024 * 1024);
        const result = importAssetArchiveV2(archivePath);
        return json(res, 200, { ...result, uploaded_bytes: upload.bytes });
      } catch (error) {
        const code = String(error?.message ?? error);
        const status = error?.code === 'payload_too_large' ? 413
          : /conflict|mismatch|corrupt/.test(code) ? 409 : 400;
        return json(res, status, { ok: false, error: 'asset_archive_import_failed', detail: code });
      } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
    }

    if (url === '/api/assets/v2/transfers' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const files = assertTransferFiles(body?.files ?? []);
        const type = body?.type === 'push' ? 'push' : 'pull';
        if (type === 'pull') files.forEach((file) => validateTransferUrl(file.url));
        const idempotencyKey = String(req.headers['idempotency-key'] ?? body?.idempotency_key ?? '');
        if (!idempotencyKey || idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey)) {
          throw Object.assign(new Error('Idempotency-Key is required for asset transfers'), { code: 'idempotency_key_required' });
        }
        const expectedGeneration = body?.expected_generation == null ? undefined : Number(body.expected_generation);
        if (expectedGeneration !== undefined && !Number.isSafeInteger(expectedGeneration)) throw Object.assign(new Error('expected_generation is invalid'), { code: 'generation_invalid' });
        const requester = {
          kind: authContext.kind,
          package_id: authContext.package_id ?? null,
          generation: authContext.generation ?? null,
        };
        const previous = findOperationByIdempotency(idempotencyKey, requester);
        if (previous) {
          const requestedAssetId = typeof body?.asset_id === 'string' ? body.asset_id : null;
          const requestedVariantId = typeof body?.variant_id === 'string' ? body.variant_id : 'generic';
          const requestedSelect = body?.select !== false;
          const sameRequest = previous.type === type
            && previous.asset_id === requestedAssetId
            && previous.variant_id === requestedVariantId
            && previous.select === requestedSelect
            && (previous.expected_generation ?? null) === (expectedGeneration ?? null)
            && v2FileIdentity(files) === v2FileIdentity(previous.files);
          if (!sameRequest) {
            throw Object.assign(new Error('Idempotency-Key was already used for a different asset operation'), {
              code: 'idempotency_key_conflict',
            });
          }
          if (type === 'pull') v2TransferInputs.set(previous.operation_id, { files, headers: v2SafeHeaders(body?.headers) });
          return json(res, 200, { ok: true, operation: v2PublicOperation(previous), deduplicated: true });
        }
        const operation = createOperation({
          type,
          assetId: typeof body?.asset_id === 'string' ? body.asset_id : null,
          variantId: typeof body?.variant_id === 'string' ? body.variant_id : 'generic',
          files,
          expectedGeneration,
          stageRoot: null,
          selection: body?.select !== false,
          metadata: v2SafeMetadata(body?.metadata),
          idempotencyKey,
          requester,
        });
        const withStage = updateOperation(operation.operation_id, { stage_root: v2OperationStage(operation.operation_id) });
        v2TransferInputs.set(operation.operation_id, { files, headers: v2SafeHeaders(body?.headers) });
        return json(res, 201, { ok: true, operation: v2PublicOperation(withStage) });
      } catch (error) { return apiError(error, 'transfer_create_failed'); }
    }
      const transferRun = url.match(/^\/api\/assets\/v2\/transfers\/([^/]+)\/run$/);
      if (transferRun && req.method === 'POST') {
        const body = await readBody(req);
        const result = await runV2Transfer(decodeURIComponent(transferRun[1]), { files: body?.files, headers: body?.headers });
      const status = result.error === 'unknown_operation' ? 404 : (result.code ?? result.operation?.error_code) === 'insufficient_space' ? 507 : 409;
      return result.ok ? json(res, 200, { ok: true, operation: v2PublicOperation(result.operation) })
        : json(res, status, { ok: false, error: result.code ?? result.error, operation: v2PublicOperation(result.operation) });
    }
    const transferFile = url.match(/^\/api\/assets\/v2\/transfers\/([^/]+)\/files\/(\d+)$/);
    if (transferFile && req.method === 'PUT') {
      try {
        const operation = readOperation(decodeURIComponent(transferFile[1]));
        if (!operation) return json(res, 404, { ok: false, error: 'unknown_operation' });
        if (operation.type !== 'push') return json(res, 409, { ok: false, error: 'push_operation_required' });
        if (['complete', 'cancelled'].includes(operation.state)) return json(res, 409, { ok: false, error: 'operation_terminal' });
        const index = Number(transferFile[2]);
        const file = operation.files?.[index];
        if (!file) return json(res, 404, { ok: false, error: 'unknown_transfer_file' });
        const stageRoot = operation.stage_root || v2OperationStage(operation.operation_id);
        const range = String(req.headers['content-range'] ?? '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
        if (range && range[3] !== '*' && Number(range[3]) !== Number(file.size)) {
          return json(res, 400, { ok: false, error: 'transfer_content_range_invalid' });
        }
        if (range && Number(range[2]) < Number(range[1])) {
          return json(res, 400, { ok: false, error: 'transfer_content_range_invalid' });
        }
        const offset = range ? Number(range[1]) : 0;
        await writePushStream(req, stageRoot, file, {
          offset,
          onProgress: (event) => {
            try { updateOperation(operation.operation_id, { bytes_done: event.bytes, current_file: event.file, stage: 'running', state: 'running' }); }
            catch { /* final commit is authoritative */ }
          },
        });
        const verified = verifyStagedFiles(operation.files, stageRoot);
        const next = updateOperation(operation.operation_id, {
          state: verified.ok ? 'staged' : 'running', stage: verified.ok ? 'staged' : 'running',
          bytes_done: verified.ok ? operation.bytes_total : (verified.bytes ?? operation.bytes_done ?? 0),
        });
        return json(res, 200, { ok: true, operation: v2PublicOperation(next), file: { index, path: file.path } });
      } catch (error) { return apiError(error, 'transfer_upload_failed'); }
    }
      const transferCommit = url.match(/^\/api\/assets\/v2\/transfers\/([^/]+)\/commit$/);
      if (transferCommit && req.method === 'POST') {
      const result = await runV2Transfer(decodeURIComponent(transferCommit[1]));
      const status = result.error === 'unknown_operation' ? 404 : (result.code ?? result.operation?.error_code) === 'insufficient_space' ? 507 : 409;
      return result.ok ? json(res, 200, { ok: true, operation: v2PublicOperation(result.operation) })
        : json(res, status, { ok: false, error: result.code ?? result.error, operation: v2PublicOperation(result.operation) });
    }
    const transferCancel = url.match(/^\/api\/assets\/v2\/transfers\/([^/]+)\/cancel$/);
    if (transferCancel && req.method === 'POST') {
      const id = decodeURIComponent(transferCancel[1]);
      const operation = readOperation(id);
      if (!operation) return json(res, 404, { ok: false, error: 'unknown_operation' });
      v2TransferControllers.get(id)?.abort(new Error('transfer cancelled by caller'));
      const next = ['complete', 'failed', 'cancelled'].includes(operation.state)
        ? operation : updateOperation(id, { state: 'cancelled', error: 'cancelled_by_caller' });
      return json(res, 200, { ok: true, operation: v2PublicOperation(next) });
    }
      const verifyMatch = url.match(/^\/api\/assets\/v2\/payloads\/([^/]+)\/verify$/);
      if (verifyMatch && req.method === 'POST') {
        const payloadId = decodeURIComponent(verifyMatch[1]);
        const ledger = readPayloadLedger();
      if (ledger.error) return json(res, 500, { ok: false, error: 'payload_ledger_corrupt', detail: ledger.error });
      const payload = ledger.payloads?.[payloadId];
      if (!payload) return json(res, 404, { ok: false, error: 'payload_not_found' });
      const verified = verifyStagedFiles(payload.files, payload.storage_path);
      return json(res, verified.ok ? 200 : 409, { ok: verified.ok, payload_id: payloadId, verification: verified });
    }
      const selectionMatch = url.match(/^\/api\/assets\/v2\/selections\/(.+)$/);
      if (selectionMatch && req.method === 'PUT') {
        const body = await readBody(req);
        try {
        if (!body || !Object.hasOwn(body, 'payload_id')) throw Object.assign(new Error('payload_id is required (or null to clear)'), { code: 'payload_id_required' });
        const expectedGeneration = body?.expected_generation == null ? undefined : Number(body.expected_generation);
        const assetId = decodeURIComponent(selectionMatch[1]);
        const result = body.payload_id === null
          ? clearPayloadSelection(assetId, body?.variant_id ?? 'generic', { expectedGeneration })
          : (typeof body.payload_id === 'string' && body.payload_id
            ? setPayloadSelection(assetId, body?.variant_id ?? 'generic', body.payload_id, { expectedGeneration })
            : (() => { throw Object.assign(new Error('payload_id must be a SHA-256 id or null'), { code: 'payload_id_invalid' }); })());
        return json(res, 200, { ok: true, generation: result.ledger.generation, selection: result.selection ?? null, changed: result.changed !== false });
        } catch (error) { return apiError(error, 'selection_update_failed'); }
      }
    const deleteMatch = url.match(/^\/api\/assets\/v2\/payloads\/([^/]+)\/delete$/);
    if (deleteMatch && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = deletePayload(decodeURIComponent(deleteMatch[1]), {
          expectedGeneration: body?.expected_generation == null ? undefined : Number(body.expected_generation),
          detach: Array.isArray(body?.detach) ? body.detach : [],
        });
        const status = result.ok ? 200 : result.error === 'payload_not_found' ? 404 : result.error === 'generation_mismatch' ? 409 : 409;
        return json(res, status, result);
      } catch (error) { return apiError(error, 'payload_delete_failed'); }
    }
    return json(res, 404, { ok: false, error: 'not_found' });
  }

  /**
   * Asset 狀態只讀接口（024 §7.1）——只回已驗證的路徑與狀態，**不回模型內容**。
   * 安裝／激活／卸載仍然只歸 Installer CLI。
   *
   * 唯一保留的 v1 兼容入口是 `POST /api/assets/<id>/fetch`；它只翻譯到舊的
   * Core transfer adapter。它不再以 optional/required、Package loaded 或 Consumer
   * 使用情況限制 payload lifecycle；正式 Manager 使用上面的 v2 operation API。
   */
  if (url === '/api/assets' || url.startsWith('/api/assets/')) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (url === '/api/assets/import' && req.method === 'POST') {
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-os-asset-upload-'));
      const archivePath = path.join(tempRoot, 'upload.tar.gz');
      try {
        const upload = await streamBodyToFile(req, archivePath,
          Number(process.env.ASSET_ARCHIVE_MAX_BYTES) || 4 * 1024 * 1024 * 1024);
        const result = importAssetArchive(archivePath);
        return json(res, 200, { ...result, uploaded_bytes: upload.bytes });
      } catch (error) {
        const code = String(error?.message ?? error);
        const status = error?.code === 'payload_too_large' ? 413
          : /conflict|mismatch|registry_conflict/.test(code) ? 409 : 400;
        return json(res, status, { ok: false, error: 'asset_archive_import_failed', detail: code });
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
    const restoreAsset = url.match(/^\/api\/assets\/(.+)\/restore$/);
    if (restoreAsset && req.method === 'POST') {
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const assetId = decodeURIComponent(restoreAsset[1]);
      const logicalModelId = parsed.searchParams.get('logical_model_id') ?? '';
      const deactivated = parsed.searchParams.get('deactivated') === '1';
      if (!/^model\.[a-z0-9._-]+$/i.test(logicalModelId) || !deactivated) {
        return json(res, 400, {
          ok: false,
          error: 'logical_restore_confirmation_required',
          detail: 'restore requires logical_model_id=model.* and deactivated=1',
        });
      }
      const r = await restoreAssetOnDemand(assetId).catch((error) => ({
        ok: false, error: 'restore_failed', detail: String(error?.message ?? error),
      }));
      const status = r.ok ? 200
        : r.error === 'already_fetching' ? 409
          : r.error === 'unknown_asset' || r.error === 'provider_not_loaded' ? 404
            : r.error === 'insufficient_space' ? 507
              : String(r.error).startsWith('target_mismatch') ? 409 : 502;
      return json(res, status, { ...r, logical_model_id: logicalModelId, restored: r.ok });
    }
    const fetchProgress = url.match(/^\/api\/assets\/(.+)\/fetch\/progress$/);
    if (fetchProgress && req.method === 'GET') {
      const assetId = decodeURIComponent(fetchProgress[1]);
      return json(res, 200, { ok: true, asset_id: assetId, progress: assetFetchProgress(assetId) });
    }
    const fetchReconcile = url.match(/^\/api\/assets\/(.+)\/fetch\/reconcile$/);
    if (fetchReconcile && req.method === 'POST') {
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const assetId = decodeURIComponent(fetchReconcile[1]);
      const requested = Number(parsed.searchParams.get('stale_after_ms'));
      const staleAfterMs = Number.isFinite(requested)
        ? Math.max(0, Math.min(30 * 60_000, requested)) : 120_000;
      const r = await reconcileAssetFetch(assetId, { staleAfterMs });
      return json(res, r.ok ? 200 : 409, { ...r, asset_id: assetId, stale_after_ms: staleAfterMs });
    }
    const fetchAsset = url.match(/^\/api\/assets\/(.+)\/fetch$/);
    if (fetchAsset && req.method === 'POST') {
      // ⚠ 取一个资产会写几百 MB 到共享 store，那不是读操作。
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const assetId = decodeURIComponent(fetchAsset[1]);
      const r = await fetchAssetOnDemand(assetId).catch((error) => ({
        ok: false, error: 'fetch_failed', detail: String(error?.message ?? error),
      }));
      // 取不到的兩種形狀要用不同狀態碼分開：這台機器沒有對應版本(409，去編一份)、
      // 根本沒這個 id(404，裝錯包)、空間不足(507)——它們的下一步動作完全不同。
      const status = r.ok ? 200
        : r.error === 'already_fetching' ? 409
          : r.error === 'unknown_asset' || r.error === 'provider_not_loaded' ? 404
          : r.error === 'insufficient_space' ? 507
            : String(r.error).startsWith('target_mismatch') ? 409 : 502;
      return json(res, status, r);
    }
    /**
     * 删除一个**按需取得**的资产载荷。
     *
     * ⛔ 只删这条路取来的。安装时就该到位的资产不许从这里删——「装好了」这个状态
     * 必须还是真的，否则一个包会在自己声称完整的时候缺着必需的东西。
     *
     * ⚠ 删的是这一份载荷，不是这个包。共享 store 里同版本同 target 的目录只有一个
     * 拥有者，所以先摘登记再删字节：反过来会留下一条指向空目录的登记。
     */
    /**
     * 装上提供这个资产的那个包。
     *
     * ⭐ **调用方只说得出一个 asset id。** 哪个包提供它、从哪取、多大，全部由目录回答——
     * 让消费方页面写死一个包名，等于把「谁供应这个模型」这件事复制到一个它无法维护的地方。
     *
     * ⚠ 有多个提供方时不替人选（与 Capability 那条同源）。
     * ⚠ 资产包不声明服务，装它不会停掉任何东西，所以不需要单独的确认步骤——
     *    这与依赖阶梯把 `supply` 里的包直接装上是同一个判断。
     */
    const installProvider = url.match(/^\/api\/assets\/(.+)\/provider$/);
    if (installProvider && req.method === 'POST') {
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const assetId = decodeURIComponent(installProvider[1]);
      if (getAssetProvider(assetId)) {
        return json(res, 409, { ok: false, error: 'already_declared', detail: `${assetId} already has an installed provider` });
      }
      const candidates = packageRegistryFindProviders(assetId, 'asset');
      if (!candidates.length) {
        return json(res, 404, { ok: false, error: 'no_provider_in_catalog', detail: `no catalog package declares ${assetId}` });
      }
      if (candidates.length > 1) {
        return json(res, 409, {
          ok: false, error: 'needs_choice',
          candidates: candidates.map((c) => c.package_id),
        });
      }
      let upload = null;
      try {
        if (packageManagerSnapshot(listPackages()).active_job) {
          throw Object.assign(new Error('another Package operation is already running'), { code: 'package_job_active' });
        }
        const remote = await downloadPackageFromRegistry(candidates[0]);
        upload = await storePackageRemoteDownload(remote.response, remote.filename, {
          expectedSize: remote.expected_size,
          expectedSha256: remote.expected_sha256,
          origin: remote.origin,
        });
        const job = startPackageJob('install', { upload_id: upload.id });
        updatePackageUpload(upload.id, { job_id: job.id });
        return json(res, 202, { ok: true, asset: assetId, package_id: candidates[0].package_id, job });
      } catch (error) {
        if (upload?.id) {
          try { discardPackageUpload(upload.id); } catch { /* keep the original failure */ }
        }
        return json(res, 502, { ok: false, error: 'provider_install_failed', detail: String(error?.message ?? error) });
      }
    }

    /**
     * 逻辑模型删除后的精确清理。它接受包随附的必需 payload，但必须同时给出
     * 逻辑模型坐标和“上层已停用”的事实；普通 `/payload` 仍严格拒绝非按需载荷。
     * 这条路不删除 Package 声明、不删除模型记录，只摘掉这一份已验证载荷登记和目录。
     */
    const dropLogicalPayload = url.match(/^\/api\/assets\/(.+)\/payload\/logical-model$/);
    if (dropLogicalPayload && req.method === 'DELETE') {
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const assetId = decodeURIComponent(dropLogicalPayload[1]);
      const logicalModelId = parsed.searchParams.get('logical_model_id') ?? '';
      const deactivated = parsed.searchParams.get('deactivated') === '1';
      if (!/^model\.[a-z0-9._-]+$/i.test(logicalModelId) || !deactivated) {
        return json(res, 400, {
          ok: false,
          error: 'logical_delete_confirmation_required',
          detail: 'logical delete requires logical_model_id=model.* and deactivated=1',
        });
      }
      const entry = readAssetRegistry().assets?.[assetId];
      if (!entry) return json(res, 404, { ok: false, error: 'unknown_asset' });
      // The registry entry is the inventory authority for this destructive,
      // logical-model-confirmed operation. Provider registration is runtime
      // state: a package may be unloaded while its verified payload remains
      // installed. Generic `/payload` deletion keeps its fetched-on-demand
      // guard; this route is the explicit deactivation boundary.
      // Registry 先摘下，避免在删除目录后仍把一个空路径说成 ready；失败时如实返回。
      deactivateAsset(assetId);
      let removed = 0;
      try {
        if (entry.path && fs.existsSync(entry.path)) {
          removed = fs.readdirSync(entry.path).length;
          fs.rmSync(entry.path, { recursive: true, force: true });
        }
      } catch (error) {
        return json(res, 500, {
          ok: false, error: 'payload_delete_failed', logical_model_id: logicalModelId,
          registry_deactivated: true, detail: String(error?.message ?? error), path: entry.path ?? null,
        });
      }
      return json(res, 200, {
        ok: true, id: assetId, logical_model_id: logicalModelId, removed_files: removed,
        path: entry.path ?? null, registry_deactivated: true,
      });
    }

    const purgeAsset = url.match(/^\/api\/assets\/(.+)\/payload$/);
    if (purgeAsset && req.method === 'DELETE' && parsed.searchParams.get('purge') === '1') {
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const assetId = decodeURIComponent(purgeAsset[1]);
      const body = await readBody(req);
      const expected = body?.expected && typeof body.expected === 'object' ? body.expected : (body ?? {});
      const result = purgeAssetPayload(assetId, { expected });
      const status = result.ok ? 200
        : ['unknown_asset', 'payload_outside_shared_store', 'payload_shared'].includes(result.error) ? 404
          : String(result.error).startsWith('expectation_mismatch') || result.error === 'payload_checksum_mismatch' ? 409
            : result.error === 'payload_delete_failed' ? 500 : 400;
      return json(res, status, result);
    }
    const dropAsset = purgeAsset;
    if (dropAsset && req.method === 'DELETE') {
      if (!authed(req, 'write')) return json(res, 403, { ok: false, error: 'write_permission_required' });
      const assetId = decodeURIComponent(dropAsset[1]);
      const entry = readAssetRegistry().assets?.[assetId];
      if (!entry) return json(res, 404, { ok: false, error: 'unknown_asset' });
      if (entry.fetched_on_demand !== true) {
        return json(res, 409, {
          ok: false,
          error: 'not_on_demand',
          detail: `${assetId} arrived with its package; removing it would make "installed" untrue`,
        });
      }
      deactivateAsset(assetId);
      let removed = 0;
      try {
        if (entry.path && fs.existsSync(entry.path)) {
          removed = fs.readdirSync(entry.path).length;
          fs.rmSync(entry.path, { recursive: true, force: true });
        }
      } catch (error) {
        return json(res, 500, { ok: false, error: 'payload_delete_failed', detail: String(error?.message ?? error) });
      }
      return json(res, 200, { ok: true, id: assetId, removed_files: removed, path: entry.path ?? null });
    }
    const variants = url.match(/^\/api\/assets\/(.+)\/variants$/);
    if (variants && req.method === 'GET') {
      const d = describeAssetVariants(decodeURIComponent(variants[1]));
      if (!d) return json(res, 404, { ok: false, error: 'unknown_asset' });
      return json(res, 200, { ok: true, ...d });
    }
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (url === '/api/assets') return json(res, 200, { ok: true, assets: listAssets() });
    const assetId = decodeURIComponent(url.slice('/api/assets/'.length));
    const d = describeAsset(assetId);
    // 沒登記也沒宣稱 = 真的不知道這個 id；已登記但沒裝好 = 200 帶 ready:false + reason
    if (!d.package && !d.version) return json(res, 404, { ok: false, error: 'unknown_asset', asset: d });
    return json(res, 200, { ok: true, asset: d });
  }

  /**
   * 本機設備畫像（023 §6）。只讀，無參數。
   *
   * ⭐ 存在的理由是「裝不上」這句話必須能被回答。一個 target 化的 Asset 拒絕安裝時，
   * 唯一有用的下一句是「本機是什麼」——沒有這個端點，使用者只看得到 mismatch 而看不到自己那一側。
   */
  if (url === '/api/system/device' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, device: deviceProfile() });
  }

  // 029 §12.4：跨組件 Artifact 只讀契約——消費方問這裡拿 owner/schema/位置，不硬編碼別家裸路徑；
  // 只有描述，無內容讀寫（讀文件仍是消費方自己的事，位置以契約為準）
  if (url === '/api/artifacts' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, artifacts: listArtifactContracts() });
  }

  if (url.startsWith('/api/stage/')) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return stageRoute(req, res, url, parsed.searchParams);
  }

  if (url === '/api/theatre' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, await theatreState());
  }

  const perform = url.match(PERFORM);
  if (perform && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const body = await readBody(req);
    if (body === null) return json(res, 400, { ok: false, error: 'invalid json' });
    const result = await performScene(perform[1], body.value ?? '');
    return json(res, result.error === 'unknown_scene' ? 404 : 200, result);
  }

  // 029 Dev Runtime API —— watch/stop/reload the single active Package worktree
  // events 是唯一公開子路由：瀏覽器注入腳本輪詢 seq 決定刷新，只暴露計數與載入狀態
  {
    const ev = url.match(/^\/api\/dev\/packages\/([\w.@-]+)\/events$/);
    if (ev && req.method === 'GET') {
      const e = devEvents(ev[1]);
      return e ? json(res, 200, { ok: true, ...e }) : json(res, 404, { ok: false, error: 'not_dev_mounted' });
    }
  }
  if (url === '/api/dev/packages' || /^\/api\/dev\/packages\//.test(url)) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (url === '/api/dev/packages' && req.method === 'GET') {
      return json(res, 200, { ok: true, watchers: listDevWatchers() });
    }
    /**
     * POST /api/dev/packages —— 開始監看一個**已安裝**的 package。
     *
     * ⚠ 不再接受 workspace / slug / data_mode。它們屬於舊的雙實體模型：那時 dev 是
     * 另一個 package，現在 dev 只是這一個 package 的 Git 狀態。靜默忽略這些欄位比
     * 報錯更糟——使用者會以為隔離資料區還在生效，而寫的其實是正式資料。
     */
    if (url === '/api/dev/packages' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b?.package_id) return json(res, 400, { ok: false, error: 'package_id required' });
      for (const gone of ['workspace', 'slug', 'data_mode']) {
        if (b[gone] !== undefined) {
          return json(res, 400, { ok: false, error: `${gone} is no longer supported`,
            detail: 'dev now watches the installed Package; there is no separate workspace or data mode.' });
        }
      }
      const r = await devWatchStart(b.package_id);
      return json(res, r.error === 'package_reconcile_required' ? 409 : r.ok ? 200 : 400, r);
    }
    const st = url.match(/^\/api\/dev\/packages\/([\w.-]+)\/status$/);
    if (st && req.method === 'GET') {
      const r = devStatus(st[1]);
      return json(res, r.ok ? 200 : 404, r);
    }
    const reconcile = url.match(/^\/api\/dev\/packages\/([\w.-]+)\/reconcile$/);
    if (reconcile && req.method === 'GET') {
      const r = devStatus(reconcile[1]);
      return json(res, r.ok ? 200 : 404, r.reconcile ?? r);
    }
    const m = url.match(/^\/api\/dev\/packages\/([\w.-]+)\/(stop|reload)$/);
    if (m && req.method === 'POST') {
      const r = m[2] === 'stop' ? await devWatchStop(m[1]) : await devReload(m[1]);
      const status = r.error === 'not_watching' || r.error === 'not_installed' ? 404
        : r.error === 'package_reconcile_required' ? 409 : r.ok ? 200 : 400;
      return json(res, status, r);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  // 027 §3：用戶觀察會話——從「現在」起只看新日誌；Clear View 只動視圖 offset，歷史日誌不刪
  if (url === '/api/observation/components' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, components: listLogComponents() });
  }
  if (url === '/api/observation' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const b = await readBody(req);
    const r = startObservation(b?.component);
    return json(res, r.ok ? 200 : 400, r);
  }
  {
    const m = url.match(/^\/api\/observation\/logs\/([\w.-]+)$/);
    if (m && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const r = readLogSlice(m[1], parsed.searchParams.get('after') ?? 0);
      if (r === null) return json(res, 404, { ok: false, error: 'unknown_component' });
      return json(res, 200, { ok: true, ...r });
    }
  }

  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });

  if (url === '/health') return json(res, 200, { ok: true, name: 'termux-os-framework', config: 'v1' });

  if (url === '/api/dev/version') return json(res, 200, { ok: true, deploy_id: deployId() });

  // 029/030：客户端先识别正式 feature/schema，再决定能否解释 Runtime Truth/更新结果。
  if (url === '/api/features') {
    return json(res, 200, {
      ok: true, schema: FEATURE_SCHEMA, framework_version: FRAMEWORK_VERSION,
      deploy_id: deployId(), features: FEATURES,
    });
  }

  // 026 §5：哥要從哪個網址打開這台機器。**公開**——連門在哪都要 token 就本末倒置了
  //（頁面本身也是公開的，真正的 API 才走 Bearer）
  if (url === '/api/access-info' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      ...accessInfo({
        device: CFG.device_name,
        version: FRAMEWORK_VERSION,
        deployId: deployId(),
        bind: HOST,
        port: PORT,
        health: 'ok',   // 這個請求本身能被回答，就說明 framework 活著
      }),
    });
  }

  if (url === '/api/admin/status') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, {
      ok: true,
      device: CFG.device_name,
      framework_version: FRAMEWORK_VERSION,
      message: 'Hello World',
      config: path.basename(CONFIG_PATH),
      deploy_id: deployId(),
    });
  }

  if (url === '/api/admin/integrity') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const report = integrityReport();
    return json(res, report.ok ? 200 : 503, report);
  }

  if (url === '/api/admin/menu') {
    if (!auth || !hasPermission(auth, 'read')) return json(res, 401, { ok: false, error: 'unauthorized' });
    const packages = listPackages().map((p) => ({ ...p, manifest: getPackage(p.id)?.manifest }));
    return json(res, 200, {
      ok: true,
      ...buildAdminMenu({ packages, permissions: auth.permissions, developerMode: CFG.developer_mode === true }),
    });
  }

  if (url === '/api/admin/overview') {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, await overviewReport());
  }

  // 剛裝好或剛更新完的設備上，登入頁是一堵沒有鑰匙的門：密碼是隨機生成寫進私有檔案的，
  // 取得它的唯一方法是開 Termux 打指令。所以本機瀏覽器先看到 Setup，而不是登入框。
  const setupStep = () => setupDecision({
    state: readSetupState(),
    local: isLoopbackAddress(req.socket?.remoteAddress),
    migrationChanged: Boolean(CONFIG_MIGRATION && migrationChangedConfig(CONFIG_MIGRATION)),
  });

  // 手機上的瀏覽器就是機主本人。密碼是用來擋別的機器的，在本機要求它只會讓使用者
  // 去找一組從來沒給過他的密碼。這裡發的是真的 Session 而不是繞過認證，所以寫入仍然
  // 受 CSRF 保護：設備上的其他網頁能對 loopback 發請求，但讀不到讓請求生效的 token。
  const localEntry = () => {
    if (auth?.kind === 'session' || !isLoopbackAddress(req.socket?.remoteAddress)) return null;
    const session = openLocalSession();
    auth = { kind: 'session', permissions: session.permissions, session };
    return sessionCookie(session);
  };

  // 登录页与它的最小静态资源公开；统一 Shell 只接受 Browser Session。
  if (url === '/admin/setup') {
    return setupStep() === 'none' ? redirect(res, '/admin/login') : serveAdminFile(res, 'setup.html');
  }
  if (url === '/admin/setup.js') return serveAdminFile(res, 'setup.js');
  if (url === '/admin/login') {
    if (setupStep() !== 'none') return redirect(res, '/admin/setup');
    // 本機沒有登入這回事：舊書籤或舊連結指到這裡時，直接讓它進去，而不是要一組沒給過的密碼。
    const cookie = localEntry();
    if (auth?.kind === 'session') {
      return redirect(res, '/admin/status/overview', cookie ? { 'Set-Cookie': cookie } : {});
    }
    return serveAdminFile(res, 'login.html');
  }
  // 登入前就要拿得到：瀏覽器是在顯示登入頁或 Setup 頁時去抓 manifest、圖示與 Service Worker 的。
  if (['/admin/login.js', '/admin/style.css', '/admin/manifest.webmanifest', '/admin/icon.svg', '/admin/i18n.js'].includes(url)) {
    return serveAdminFile(res, ADMIN_FILES.get(url));
  }
  // 语言目录在登录之前就要拿得到：登录页本身也要按选择的语言显示。
  {
    const m = url.match(/^\/admin\/i18n\/([\w-]+)\.json$/);
    if (m) return serveStatic(res, path.join(ROOT, 'web/admin/i18n'), `${m[1]}.json`);
  }
  if (url === '/admin/sw.js') {
    // 腳本在 /admin/ 之下，預設最大 scope 就是 /admin/，涵蓋不到不帶斜線的 /admin。
    // 這個標頭把 scope 放寬到 /admin，讓入口本身也受控制。
    const file = path.join(ROOT, 'web/admin', 'sw.js');
    if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Service-Worker-Allowed': '/admin' });
    return res.end(fs.readFileSync(file));
  }
  if (url === '/admin' || url === '/admin/') {
    // Setup 在這裡直接以 200 回應，而不是導向 /admin/setup。更新期間跑 core-check 的是
    // **舊版本的** 控制器，它要求 /admin 回 200；改成轉址會讓每一次從舊版本上來的更新
    // 都在 post-check 失敗並回滾——也就是新版本誰都裝不上。
    if (setupStep() !== 'none') return serveAdminFile(res, 'setup.html');
    const cookie = localEntry();
    if (auth?.kind === 'session') {
      return redirect(res, '/admin/status/overview', cookie ? { 'Set-Cookie': cookie } : {});
    }
    return serveAdminFile(res, 'login.html');
  }
  if (url.startsWith('/admin/')) {
    const cookie = localEntry();
    if (cookie) res.setHeader('Set-Cookie', cookie);
    if (auth?.kind !== 'session') return redirect(res, `/admin/login?next=${encodeURIComponent(url)}`);
    const file = ADMIN_FILES.get(url);
    if (file) return serveAdminFile(res, file);
    const packages = listPackages().map((p) => ({ ...p, manifest: getPackage(p.id)?.manifest }));
    const adminMenu = buildAdminMenu({ packages, developerMode: CFG.developer_mode === true });
    if (!adminMenuHasPath(adminMenu, url)) return json(res, 404, { ok: false, error: 'unknown_admin_page' });
    return serveAdminFile(res, 'index.html');
  }

  // Package WebUI 静态也只接受统一 Browser Session；SDK/CLI 仍只走 Bearer API。
  // 029：Dev Mount 的頁面由 Framework 注入 DEV banner + 自動刷新輪詢；載入失敗顯示錯誤頁不冒充成功
  if (url.startsWith('/packages/')) {
    const cookie = localEntry();
    if (cookie) res.setHeader('Set-Cookie', cookie);
    if (auth?.kind !== 'session') return redirect(res, `/admin/login?next=${encodeURIComponent(url)}`);
    const m = url.match(/^\/packages\/([\w.@-]+)(\/.*)?$/);
    if (!m) return json(res, 404, { ok: false, error: 'unknown_package' });
    const [, pkgId, subPath] = m;
    const rel = !subPath || subPath === '/' ? 'index.html' : subPath.slice(1);
    if (isDevWatched(pkgId)) {
      const ev = devEvents(pkgId);
      if (ev.status !== 'loaded' && rel.endsWith('.html')) return serveDevErrorPage(res, pkgId, ev);
      const webRoot = getPackageWebRoot(pkgId);
      if (!webRoot) return json(res, 404, { ok: false, error: 'unknown_package' });
      if (rel.endsWith('.html')) return serveDevHtml(res, webRoot, rel, pkgId);
      return serveStatic(res, webRoot, rel);
    }
    const webRoot = getPackageWebRoot(pkgId);
    if (!webRoot) return json(res, 404, { ok: false, error: 'unknown_package' });
    return rel.endsWith('.html') ? servePackageHtml(res, webRoot, rel) : serveStatic(res, webRoot, rel);
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

const upgradeStatusText = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway' };
const rejectUpgrade = (socket, status, message) => {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end([
    `HTTP/1.1 ${status} ${upgradeStatusText[status] ?? 'Error'}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
};

server.on('upgrade', (req, socket, head) => {
  let parsed;
  try { parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); }
  catch { return rejectUpgrade(socket, 400, 'invalid websocket request'); }
  const match = parsed.pathname.match(/^\/api\/packages\/([\w.@-]+)(\/.*)?$/);
  if (!match || req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    return rejectUpgrade(socket, 404, 'unknown websocket route');
  }
  const auth = authenticateRequest(req);
  if (auth?.kind !== 'session' || !hasPermission(auth, 'read')) {
    return rejectUpgrade(socket, 401, 'browser session required');
  }
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) {
        return rejectUpgrade(socket, 403, 'websocket origin rejected');
      }
    } catch {
      return rejectUpgrade(socket, 403, 'websocket origin rejected');
    }
  }
  const subpath = match[2] ?? '/';
  const handler = dispatchPackageWebSocket(match[1], subpath);
  if (!handler) return rejectUpgrade(socket, 404, 'unknown websocket route');
  Promise.resolve(handler(req, socket, head, {
    packageId: match[1],
    query: parsed.searchParams,
    auth,
  })).catch((error) => {
    console.warn(`Package WebSocket route failed for ${match[1]}${subpath}: ${String(error?.message ?? error)}`);
    rejectUpgrade(socket, 502, 'package websocket unavailable');
  });
});

server.listen(PORT, HOST, () => {
  controlPlaneListening = true;
  console.log(`termux-os-framework listening on http://${HOST}:${PORT} (config: ${CONFIG_PATH})`);
  setImmediate(beginStartupRestore);
});
