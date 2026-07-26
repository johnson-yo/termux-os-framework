/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: web/admin/app.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

async function loadOverview() {
  const response = await api('/api/admin/overview');
  if (!response.ok) throw new Error(`Overview HTTP ${response.status}`);
  renderOverview(await response.json());
}

// `renderer` 来自 server 的 CORE_ADMIN_PAGES；Package 节点直接跳 Package 自己的 WebUI，
// 不会落到 core Shell。新增 core 页面必须同时在注册表给出真实 renderer，故没有 placeholder 状态。
const PAGE_RENDERERS = {
  overview: loadOverview,
  applications: renderApplications,
  services: renderServices,
  logs: renderLogs,
  runtime: renderRuntime,
  system: renderSystem,
  administration: renderAdministration,
  sdk: renderSdk,
  package_settings: loadPackageSettings,
  adapters: loadAdapters,
  packages: loadPackageManager,
  framework_update: loadFrameworkUpdate,
  developer_resources: renderDeveloperResources,
};

async function loadPage() {
  const path = location.pathname === '/admin' ? '/admin/status/overview' : location.pathname;
  pageCleanup?.();
  pageCleanup = null;
  if (packagePollTimer) { clearTimeout(packagePollTimer); packagePollTimer = null; }
  if (frameworkUpdatePollTimer) { clearTimeout(frameworkUpdatePollTimer); frameworkUpdatePollTimer = null; }
  showCopy(path);
  const page = flatMenu(menu).find((node) => node.path === path);
  const renderPage = page?.renderer ? page : flatMenu(menu).find((node) => node.path === page?.default_child);
  const render = PAGE_RENDERERS[renderPage?.renderer];
  if (!render) throw new Error(`No registered renderer for ${path}`);
  return render();
}

async function boot() {
  await window.TermuxOS.ready;
  const [menuResponse, statusResponse] = await Promise.all([
    api('/api/admin/menu'),
    api('/api/admin/status'),
  ]);
  const menuResult = await menuResponse.json();
  const status = await statusResponse.json();
  menu = menuResult.menu ?? [];
  renderNavigation(menu);
  $('version').textContent = status.framework_version ?? 'unknown';
  knownBuild = status.deploy_id;
  await loadPage();
}

$('menu-button').addEventListener('click', () => {
  setNavigationOpen(!document.body.classList.contains('nav-open'));
});
$('nav-scrim').addEventListener('click', () => setNavigationOpen(false));
$('logout').addEventListener('click', () => window.TermuxOS.logout());

setInterval(async () => {
  try {
    const result = await (await fetch('/api/dev/version')).json();
    if (knownBuild && result.deploy_id !== knownBuild) location.reload();
  } catch { /* Framework restart window */ }
}, 3000);

boot().catch((error) => {
  replacePage(text('p', `Unable to load this page: ${error.message ?? error}`, 'alert error'));
});
