/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: Authenticated HTTP/WebSocket routes, Package Registry details, and explicit local-install safety confirmation.
 * [POS]: src/server.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { registerAction, listActions, performScene } from './theatre/runtime.mjs';
import { acts, scenes, scripts } from './theatre/catalog.mjs';
import { builtinActions } from './theatre/adapters.mjs';
import * as stage from './stage/manager.mjs';
import {
  loadPackages, loadSinglePackage, unregisterPackage, _getRecord,
  listPackages, getPackage, getPackageWebRoot, dispatchPackageRoute, dispatchPackageWebSocket, listArtifactContracts,
} from './packages/loader.mjs';
import { resolveInstalledPackages } from './packages/installed-root.mjs';
import {
  initDevRuntime, devMount, devUnmount, devReload, listDevMounts, isDevMounted, devEvents,
} from './packages/dev-runtime.mjs';
import { listCapabilities, describeCapability, setCapabilityBinding, invokeCapability } from './capabilities/resolver.mjs';
import { listAppsWithState, getAppState, prepareApp } from './apps/coordinator.mjs';
import { collectMetrics } from './system/metrics.mjs';
import { accessInfo } from './system/access.mjs';
import {
  authenticateRequest, browserSessionInfo, clearSessionCookie, configureBrowserAuth, csrfValid, openLocalSession,
  hasPermission, loginBrowser, logoutBrowser, sessionCookie, updateBrowserAuth, verifyBrowserPassword,
} from './system/auth.mjs';
import { adminMenuHasPath, buildAdminMenu } from './system/menu.mjs';
import { configOverrides, migrateConfig, migrationChangedConfig } from './system/config-migrate.mjs';
import { configureSetupState, isLoopbackAddress, readSetupState, setupDecision, writeSetupState } from './system/setup-state.mjs';
import {
  configurePackageControl, discardPackageUpload, getPackageJob, getPackageUpload,
  packageManagerSnapshot, startPackageJob, storePackageRemoteDownload, storePackageUpload, updatePackageUpload,
} from './system/package-control.mjs';
import {
  DEFAULT_PACKAGE_REGISTRY_URL, configurePackageRegistry, downloadPackageFromRegistry,
  downloadFrameworkFromRegistry, frameworkRegistryInfo, packageRegistryContainsSha256,
  packageRegistryDetails, packageRegistrySnapshot, refreshPackageRegistry,
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
import { listAssets, describeAsset } from './assets/runtime.mjs';
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
  system_key_masked: secretMask(CFG.auth.admin_token),
  system_key_preview: secretMask(CFG.auth.admin_token),
  system_key_length: CFG.auth.admin_token.length,
  system_key_uses: ['Framework API', 'Package-to-Package HTTP API', 'third-party App HTTP API'],
  login_password: {
    configured: Boolean(CFG.auth.admin_password),
    minimum_length: AUTH_PASSWORD_MIN_LENGTH,
  },
  note: credentialsEditable
    ? 'The System Key is masked by default. Use Copy key when a trusted Browser Session needs the full value.'
    : 'Credentials are managed outside the private Framework credential file; edit the environment or config source.',
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

// ============================================================
// 029 Dev Runtime 的頁面注入：DEV banner（醒目、不可誤認正式）+ seq 輪詢自動刷新；
// 載入失敗時整頁換錯誤頁（保 Framework、不自動切回 Installed 冒充成功）
// ============================================================
const devInjection = (pkgId, seq) => `
<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#b45309;color:#fff;
  font:600 13px/1.6 system-ui;padding:4px 12px;text-align:center">
  DEV WORKSPACE — Not Installed Release — Not eligible for release verification
</div>
<script>(function(){var last=${seq};setInterval(function(){
  fetch('/api/dev/packages/${pkgId}/events').then(function(r){return r.json();}).then(function(d){
    if(d.seq!==last||d.status!=='loaded')location.reload();
  }).catch(function(){});},1500);})();</script>`;

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
<div style="background:#b45309;color:#fff;font-weight:600;padding:6px 12px;border-radius:6px">
DEV WORKSPACE — 載入失敗（Framework 本體正常）</div>
<h2 style="color:#fca5a5">${pkgId}</h2>
<pre style="white-space:pre-wrap;background:#292524;padding:1rem;border-radius:8px;color:#fda4af">${
  String(ev.error ?? 'unknown error').replace(/</g, '&lt;')}</pre>
<p>修好 Workspace 代碼後會自動重載；或手動：<code>./sdk/termux-os-sdk dev reload ${pkgId}</code></p>
<button onclick="location.reload()" style="padding:.5rem 1rem;border-radius:6px;border:0;background:#57534e;color:#fff">Retry Reload</button>
<script>setInterval(function(){fetch('/api/dev/packages/${pkgId}/events').then(function(r){return r.json();})
.then(function(d){if(d.status==='loaded')location.reload();}).catch(function(){});},1500);</script>
</body>`);
}

// 030 Browser Session：Installed Package 是不可变 Release，不为认证迁移重打十个包。
// Host 在返回 HTML 时注入同源 session 请求上下文并隐藏旧 token 输入；Package 原文件与 SHA 不变。
// PWA：/admin 是使用者的日常入口，桌面圖示讓它不必先開瀏覽器再找網址。
// Service Worker 的 scope 只有 /admin/，並且把版本帶進 URL——否則更新後仍會拿到舊版本的 shell。
const pwaInjection = () => `<link rel="manifest" href="/admin/manifest.webmanifest">
<link rel="icon" href="/admin/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#18212b">
<script>if('serviceWorker'in navigator){window.addEventListener('load',function(){
// updateViaCache:'none' 讓瀏覽器每次都去問這支腳本本身，否則裝成 App 之後可能長期停在舊的一份。
navigator.serviceWorker.register('/admin/sw.js?v=${encodeURIComponent(FRAMEWORK_VERSION)}',
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
  let out = html.replace(/(<input\b[^>]*\bid=["']token["'][^>]*\bvalue=)(["'])[^"']*\2/gi, '$1""');
  if (!out.includes('/admin/session.js')) {
    const tag = '<script src="/admin/session.js"></script>';
    out = out.replace(/(<script\b[^>]*\bsrc=(["'])(?:\.\/)?app\.js\2[^>]*>)/i, `${tag}\n$1`);
    if (!out.includes(tag)) out = out.replace('</body>', `${tag}</body>`);
  }
  const compat = `<style>#token,label[for="token"]{display:none!important}</style>
<script>window.TermuxOS.ready.then(function(){
  var t=document.getElementById('token'); if(t){t.type='hidden';t.value='browser-session';
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
await loadPackages({ frameworkVersion: FRAMEWORK_VERSION, config: CFG, configPath: CONFIG_PATH, saveConfig: persistConfiguration });

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
// restore 必須在 reconcile 之後：收編倖存進程 → 只補啟 desired=running 且未運行者（020 §12.3）
const restored = await stage.restoreDesiredServices();
if (restored.length) console.log(`stage restore: ${JSON.stringify(restored.map((r) => ({ id: r.id, ok: r.ok })))}`);

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
  if (isDevMounted(id)) throw Object.assign(new Error('Package is shadowed by Dev Runtime'), { code: 'package_dev_mounted' });
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
  if (isDevMounted(id)) throw Object.assign(new Error('Package is shadowed by Dev Runtime'), { code: 'package_dev_mounted' });
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
  if (isDevMounted(id)) throw Object.assign(new Error('Package is shadowed by Dev Runtime'), { code: 'package_dev_mounted' });
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
    desired_restore: { ok: restored.every((r) => r.ok !== false),
      failures: restored.filter((r) => r.ok === false).map((r) => ({ id: r.id, error: r.error ?? null })) },
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
    const mounts = listDevMounts();
    for (const m of mounts) attention.push({ kind: 'dev', severity: 'warning',
      title: `Dev Runtime active: ${m.package_id}`, detail: m.workspace, href: '/admin/system/developer' });
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

// 025 §8.5：上次沒收乾淨的 Session（App 崩了/framework 掛了）——被 quiesce 的 Service 不能一直停著
const recovered = await recoverStaleSessions(sessionDeps);
if (recovered.length) console.log(`app sessions recovered: ${JSON.stringify(recovered)}`);

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
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://x');
  const url = parsed.pathname;
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

  // 030 Section 4：WebUI 只上传、确认、启动/轮询外部 job；真正生命周期仍唯一进入
  // scripts/package-manager.mjs。worker 脱离本进程，故 install 引发 Framework restart 也不会丢结果。
  const packageControlError = (error) => {
    const code = error?.code ?? 'package_control_failed';
    const status = code === 'upload_too_large' ? 413
      : code.startsWith('unknown_') ? 404
        : ['package_job_active', 'upload_job_active', 'preflight_required', 'confirmation_mismatch', 'unverified_release_confirmation_required']
          .includes(code) ? 409 : 400;
    return json(res, status, { ok: false, error: code, detail: String(error?.message ?? error) });
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
    const confirmation = body?.confirm_password ?? body?.confirm;
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
    if (password !== confirmation) return json(res, 400, { ok: false, error: 'login_password_mismatch' });
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
      return json(res, 200, {
        ok: true,
        ...snapshot,
        uploads: snapshot.uploads.map((upload) => ({
          ...upload,
          registry_verified: packageRegistryContainsSha256(upload.sha256),
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
    const m = url.match(/^\/api\/admin\/package-manager\/uploads\/([\w.@-]+)\/(check|install)$/);
    if (m && req.method === 'POST') {
      try {
        const upload = getPackageUpload(m[1]);
        if (!upload) throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
        if (m[2] === 'install') {
          const body = await readBody(req);
          if (!upload.preflight?.ok || upload.status !== 'preflight_passed') {
            throw Object.assign(new Error('successful preflight required before install'), { code: 'preflight_required' });
          }
          if (body?.confirm_sha256 !== upload.sha256) {
            throw Object.assign(new Error('confirmed Release SHA does not match upload'), { code: 'confirmation_mismatch' });
          }
          if (!packageRegistryContainsSha256(upload.sha256) && body?.confirm_unverified !== true) {
            throw Object.assign(new Error('this archive is not present in the verified Registry catalog; explicit acknowledgement is required'), {
              code: 'unverified_release_confirmation_required',
            });
          }
        }
        const job = startPackageJob(m[2], { upload_id: upload.id });
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
      dev_mounts: listDevMounts().map((m) => ({
        package_id: m.package_id, instance_id: m.instance_id, workspace: m.workspace,
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
    if (url === '/api/packages' && req.method === 'GET') {
      return json(res, 200, { ok: true, framework_version: FRAMEWORK_VERSION, packages: listPackages() });
    }
    const m = url.match(/^\/api\/packages\/([\w.@-]+)(\/.*)?$/);
    if (!m) return json(res, 404, { ok: false, error: 'not found' });
    const [, pkgId, sub] = m;
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

  // Asset 狀態只讀接口（024 §7.1）——只回已驗證的路徑與狀態，**不回模型內容**；
  // 寫入（安裝/激活/卸載）只歸 Installer CLI，Framework 不開這道口
  if (url === '/api/assets' || url.startsWith('/api/assets/')) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (url === '/api/assets') return json(res, 200, { ok: true, assets: listAssets() });
    const assetId = decodeURIComponent(url.slice('/api/assets/'.length));
    const d = describeAsset(assetId);
    // 沒登記也沒宣稱 = 真的不知道這個 id；已登記但沒裝好 = 200 帶 ready:false + reason
    if (!d.package && !d.version) return json(res, 404, { ok: false, error: 'unknown_asset', asset: d });
    return json(res, 200, { ok: true, asset: d });
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

  // 029 Dev Runtime API —— 掛載/停止/重載 Workspace Package（帶 POST：必須在 GET-only 閘門之前）
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
      return json(res, 200, { ok: true, mounts: listDevMounts() });
    }
    if (url === '/api/dev/packages' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b?.package_id || !b?.workspace) {
        return json(res, 400, { ok: false, error: 'package_id and workspace required' });
      }
      const r = await devMount(b.package_id, {
        workspace: b.workspace,
        dataMode: b.data_mode === 'live' ? 'live' : 'isolated',
        slug: b.slug ?? null,
      });
      return json(res, r.ok ? 200 : 400, r);
    }
    const m = url.match(/^\/api\/dev\/packages\/([\w.@-]+)\/(stop|reload)$/);
    if (m && req.method === 'POST') {
      const r = m[2] === 'stop' ? await devUnmount(m[1]) : await devReload(m[1]);
      return json(res, r.error === 'not_mounted' ? 404 : r.ok ? 200 : 400, r);
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

  // 登录页与它的最小静态资源公开；统一 Shell 只接受 Browser Session。
  if (url === '/admin/setup') {
    return setupStep() === 'none' ? redirect(res, '/admin/login') : serveAdminFile(res, 'setup.html');
  }
  if (url === '/admin/setup.js') return serveAdminFile(res, 'setup.js');
  if (url === '/admin/login') {
    if (setupStep() !== 'none') return redirect(res, '/admin/setup');
    if (auth?.kind === 'session') return redirect(res, '/admin/status/overview');
    return serveAdminFile(res, 'login.html');
  }
  // 登入前就要拿得到：瀏覽器是在顯示登入頁或 Setup 頁時去抓 manifest、圖示與 Service Worker 的。
  if (['/admin/login.js', '/admin/style.css', '/admin/manifest.webmanifest', '/admin/icon.svg'].includes(url)) {
    return serveAdminFile(res, ADMIN_FILES.get(url));
  }
  if (url === '/admin/sw.js') {
    // 腳本在 /admin/ 之下，預設最大 scope 就是 /admin/，涵蓋不到不帶斜線的 /admin。
    // 這個標頭把 scope 放寬到 /admin，讓入口本身也受控制。
    const file = path.join(ROOT, 'web/admin', 'sw.js');
    if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Service-Worker-Allowed': '/admin' });
    return res.end(fs.readFileSync(file));
  }
  // 手機上的瀏覽器就是機主本人。密碼是用來擋別的機器的，在本機要求它只會讓使用者
  // 去找一組從來沒給過他的密碼。這裡發的是真的 Session 而不是繞過認證，所以寫入仍然
  // 受 CSRF 保護：設備上的其他網頁能對 loopback 發請求，但讀不到讓請求生效的 token。
  const localEntry = () => {
    if (auth?.kind === 'session' || !isLoopbackAddress(req.socket?.remoteAddress)) return null;
    const session = openLocalSession();
    auth = { kind: 'session', permissions: session.permissions, session };
    return sessionCookie(session);
  };

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
    if (isDevMounted(pkgId)) {
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
  console.log(`termux-os-framework listening on http://${HOST}:${PORT} (config: ${CONFIG_PATH})`);
});
