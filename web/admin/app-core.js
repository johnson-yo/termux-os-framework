/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The portrait Admin Shell renderers, shared card surfaces, and authenticated control actions.
 * [POS]: web/admin/app-core.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const $ = (id) => document.getElementById(id);
const api = (...args) => window.TermuxOS.api(...args);
// 所有界面文字都经过下面这几个组件，所以翻译只在这里接一次。
// 经典脚本共用同一个全局作用域，所以这里不能叫 t——i18n.js 已经声明了那个名字。
const tr = (value) => (window.TermuxOSI18n?.t ? window.TermuxOSI18n.t(value) : value);

const text = (tag, value, className) => Object.assign(document.createElement(tag), {
  // 翻译在这里发生：所有界面文字都经由 text/valueRow/statusRow/actionButton 产生，
  // 在出口接一次，就不必在几百个调用点各写一遍。
  textContent: tr(value ?? 'n/a'), className: className ?? '',
});

let menu = [];
let knownBuild = null;
let packageTab = 'installed';
let packageFilter = 'all';
let packageSearch = '';
let packageNotice = null;
let packageSettingNotice = null;
let packagePollTimer = null;
let packageReconnectSince = 0;
let frameworkUpdateNotice = null;
let frameworkUpdatePollTimer = null;
let frameworkUpdateReconnectSince = 0;
let pageCleanup = null;
let serviceNotice = null;
let applicationNotice = null;
let administrationNotice = null;

const flatMenu = (nodes) => nodes.flatMap((node) => [node, ...flatMenu(node.children ?? [])]);
const canWrite = () => window.TermuxOS.session?.permissions?.includes('write') === true;

// PWA 安裝提示。beforeinstallprompt 只在瀏覽器認為可安裝時才觸發——例如 127.0.0.1 這種
// 安全上下文；用 LAN 位址開啟時不會有，所以這條提示不會出現，也不該假裝可以裝。
let installPrompt = null;
const INSTALL_DISMISSED = 'termux-os.install-dismissed';

function setupInstallPrompt() {
  const bar = document.getElementById('install-bar');
  if (!bar) return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    if (localStorage.getItem(INSTALL_DISMISSED) !== '1') bar.hidden = false;
  });
  window.addEventListener('appinstalled', () => { bar.hidden = true; installPrompt = null; });
  document.getElementById('install-dismiss')?.addEventListener('click', () => {
    localStorage.setItem(INSTALL_DISMISSED, '1');
    bar.hidden = true;
  });
  document.getElementById('install-accept')?.addEventListener('click', async () => {
    if (!installPrompt) return;
    bar.hidden = true;
    installPrompt.prompt();
    // 使用者拒絕就不要再纏著他；瀏覽器本身也不會再觸發同一次提示。
    const choice = await installPrompt.userChoice.catch(() => null);
    if (choice?.outcome === 'dismissed') localStorage.setItem(INSTALL_DISMISSED, '1');
    installPrompt = null;
  });
}

function setNavigationOpen(open) {
  document.body.classList.toggle('nav-open', open);
  $('menu-button').setAttribute('aria-expanded', String(open));
  $('menu-button').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  $('nav-scrim').hidden = !open;
}

function replacePage(...nodes) {
  pageCleanup?.();
  pageCleanup = null;
  const stack = document.createElement('div');
  stack.className = 'page-stack';
  stack.append(...nodes.filter(Boolean));
  $('page').replaceChildren(stack);
}

function showCopy(path) {
  const found = flatMenu(menu).find((node) => node.path === path);
  const parent = found?.parent ? flatMenu(menu).find((node) => node.path === found.parent) : null;
  const copySource = found?.description ? found : flatMenu(menu).find((node) => node.path === found?.default_child);
  const title = found?.title ?? 'Administration';
  // 页头与导航的文字也来自组件之外的直接赋值，同样要过翻译，否则切了语言之后
  // 只有卡片变了、标题栏没变。
  $('breadcrumb').textContent = parent ? `${tr(parent.title)} / ${tr(title)}` : tr(title);
  $('page-title').textContent = tr(title);
  $('page-description').textContent = tr(copySource?.description ?? '这个页面使用共享的浏览器会话与管理层级。');
  document.title = `${title} — Termux-OS`;
}

function renderNavigation(nodes) {
  const nav = $('navigation');
  nav.replaceChildren(...nodes.map((node) => {
    const group = document.createElement('section');
    group.className = 'nav-group';
    const top = document.createElement('a');
    top.className = 'nav-top';
    top.href = node.default_child ?? node.path;
    top.textContent = tr(node.title);
    top.addEventListener('click', () => setNavigationOpen(false));
    group.append(top);
    if (node.children?.length) {
      const list = document.createElement('div');
      list.className = 'nav-children';
      for (const child of node.children) {
        const link = document.createElement('a');
        const href = child.default_child ?? child.path;
        link.href = href;
        link.textContent = tr(child.title);
        // Package 自有頁面不在 /admin/ 下，它們是獨立的 WebUI——用新分頁開，
        // 免得使用者從自己的 App 回不到管理台。core 頁面仍是同分頁導航。
        if (!href.startsWith('/admin/')) {
          link.target = '_blank';
          link.rel = 'noopener';
        } else if (location.pathname === href) {
          link.classList.add('active');
        }
        link.addEventListener('click', () => setNavigationOpen(false));
        list.append(link);
      }
      group.append(list);
    } else if (location.pathname === top.getAttribute('href')) {
      top.classList.add('active');
    }
    return group;
  }));
}

async function refreshAdminNavigation() {
  const response = await api('/api/admin/menu');
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail ?? result.error ?? 'admin_menu_failed');
  menu = result.menu ?? [];
  renderNavigation(menu);
}

const valueRow = (label, value) => {
  const row = document.createElement('div');
  row.className = 'value-row';
  row.append(text('span', label), text('b', value ?? 'n/a'));
  return row;
};

/**
 * 面板卡片。所有页面共用这一个，标题行与主体的写法只有这一处。
 *
 * `collapsed` 让卡片可折叠：记录类的内容（作业进度、更新历史）默认收起，需要时展开。
 * 先前只有「最近的操作」自己用 <details> 实现了折叠，别的卡片没有——同一页里两种交互，
 * 用户无从知道哪一块能收起来。折叠状态按标题记在本地，切页回来还是原样。
 */
const COLLAPSED_KEY = 'termux-os.collapsed-panels';
const collapsedSet = () => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')); } catch { return new Set(); }
};
const rememberCollapsed = (title, collapsed) => {
  const set = collapsedSet();
  if (collapsed) set.add(title); else set.delete(title);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); } catch { /* 隐私模式下无所谓 */ }
};

const section = (title, href = null, { collapsible = false, collapsed = false } = {}) => {
  const card = document.createElement('section');
  card.className = 'panel';
  const head = document.createElement('div');
  head.className = 'panel-head';
  head.append(text('h2', title));
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = tr('详情');
    head.append(link);
  }
  const body = document.createElement('div');
  body.className = 'panel-body';
  if (collapsible) {
    const remembered = collapsedSet();
    const start = remembered.has(title) || (collapsed && !remembered.has(`!${title}`));
    card.classList.add('is-collapsible');
    const toggle = actionButton(start ? '展开' : '收起', 'quiet', () => {
      const nowCollapsed = !card.classList.contains('is-collapsed');
      card.classList.toggle('is-collapsed', nowCollapsed);
      toggle.textContent = tr(nowCollapsed ? '展开' : '收起');
      toggle.setAttribute('aria-expanded', String(!nowCollapsed));
      rememberCollapsed(title, nowCollapsed);
    });
    toggle.setAttribute('aria-expanded', String(!start));
    card.classList.toggle('is-collapsed', start);
    head.append(toggle);
  }
  card.append(head, body);
  // 暴露 head，讓呼叫方能在標題行右側掛按鈕（例如 Workspace 的 Share your App）
  return { card, head, body };
};

const componentError = (body, component) => {
  body.append(text('p', component?.error ?? 'This component did not return data.', 'alert error'));
};

function renderOverview(data) {
  const state = overviewState(data);
  const hero = document.createElement('section');
  hero.className = 'control-hero';
  const heroCopy = document.createElement('div');
  heroCopy.className = 'control-hero-copy';
  heroCopy.append(
    text('p', '控制中心', 'eyebrow'),
    text('h2', state.label),
    text('p', state.detail, 'hero-description'),
  );
  const issues = document.createElement('div');
  issues.className = 'control-hero-issues';
  if (!data.attention.length) {
    issues.append(text('p', '无需处理，控制面一切正常。', 'empty'));
  } else {
    issues.append(text('p', '操作队列', 'control-hero-issues-label'));
    for (const item of data.attention) {
      const row = document.createElement('a');
      row.className = `attention ${item.severity}`;
      row.href = item.href;
      row.append(text('b', item.title), text('span', item.detail));
      issues.append(row);
    }
  }
  heroCopy.append(issues);
  const heroMeta = document.createElement('div');
  heroMeta.className = 'control-hero-meta';
  heroMeta.append(
    text('span', state.label, `status ${state.kind}`),
    text('small', `${tr('更新于')} ${new Date(data.generated_at).toLocaleTimeString()}`, 'meta'),
  );
  hero.append(heroCopy, heroMeta);

  const grid = document.createElement('div');
  grid.className = 'overview-grid';
  const resources = data.components.resources;
  const framework = data.components.framework;
  const packages = data.components.packages;
  const applications = data.components.applications;
  const adapters = data.components.adapters;
  const services = data.components.services;

  const app = section('应用', '/admin/applications');
  if (!applications?.ok) componentError(app.body, applications);
  else {
    const v = applications.value;
    app.body.append(
      valueRow('已安装', v.installed),
      valueRow('就绪', v.loaded),
      valueRow('已停用', v.disabled),
      valueRow('需要处理', v.failed),
    );
  }

  const svc = section('服务', '/admin/services/overview');
  if (!services.ok) componentError(svc.body, services);
  else {
    const v = services.value;
    svc.body.append(
      valueRow('运行中', v.running),
      valueRow('已停止', v.stopped),
      valueRow('失败', v.failed),
      valueRow('已注册', v.total),
    );
  }

  const pkg = section('Package', '/admin/packages/overview');
  if (!packages.ok) componentError(pkg.body, packages);
  else {
    const v = packages.value;
    pkg.body.append(
      valueRow('已安装', v.installed),
      valueRow('已加载', v.loaded),
      valueRow('失败 / 降级', `${v.failed} / ${v.degraded}`),
      valueRow('更新', v.available_updates ?? 'n/a'),
    );
  }

  const adapter = section('Adapter', '/admin/adapters/overview');
  if (!adapters?.ok) componentError(adapter.body, adapters);
  else {
    const v = adapters.value;
    adapter.body.append(
      valueRow('已安装', v.installed),
      valueRow('就绪', v.loaded),
      valueRow('已停用', v.disabled),
      valueRow('需要处理', v.failed),
    );
  }

  const sys = section('系统', '/admin/system/system');
  sys.body.append(
    valueRow('设备', data.system.device),
    valueRow('平台', data.system.platform),
    valueRow('Android', data.system.android),
    valueRow('Termux', data.system.termux_prefix),
    valueRow('当前时间', new Date(data.generated_at).toLocaleString()),
    valueRow('Framework 已运行', resources.ok ? formatDuration(resources.value.framework_uptime_s) : 'n/a'),
  );
  if (!resources.ok) componentError(sys.body, resources);
  else {
    const m = resources.value;
    sys.body.append(
      valueRow('内存', m.memory ? `${tr('可用')} ${m.memory.available_mb} MB / ${tr('共')} ${m.memory.total_mb} MB` : 'n/a'),
      valueRow('存储', m.storage?.sdcard ? `${tr('可用')} ${m.storage.sdcard.free_gb} GB / ${tr('共')} ${m.storage.sdcard.total_gb} GB` : 'n/a'),
      valueRow('CPU', m.cpu?.usage_percent == null ? `${m.cpu?.cores ?? tr('未知')} ${tr('核')} · ${tr('负载未知')}` : `${m.cpu.usage_percent}% · ${m.cpu.cores} ${tr('核')}`),
      valueRow('温度', m.temperature ? `${m.temperature.celsius} °C` : 'n/a'),
      valueRow('设备已运行', formatDuration(m.device_uptime_s)),
    );
  }
  if (!framework.ok) componentError(sys.body, framework);
  else {
    const v = framework.value;
    sys.body.append(
      statusRow('Framework 健康', v.health, v.health === 'healthy' ? 'good' : 'bad'),
      valueRow('Framework 版本', v.version),
      valueRow('Framework 构建', v.build),
      valueRow('上次更新', v.last_update ? `${stateWord(v.last_update.status)} · ${v.last_update.candidate_build ?? '未知构建'}` : '没有记录'),
    );
  }
  // 设备与 Framework 排在最前：打开概览时第一个想知道的是「这台机器现在怎么样」，
  // 而不是「装了哪些应用」。应用、服务、Package、Adapter 属于其后的细分。
  grid.append(sys.card, app.card, svc.card, pkg.card, adapter.card);
  replacePage(hero, grid);
  // 运行时细节接在概览底下。⚠ 它是异步的，而概览是同步渲染的，所以只在这一页
  // 仍然停留时才追加——否则使用者切走之后，两张属于上一页的卡会落到新页面上。
  const renderedFor = location.pathname;
  runtimeCards(data).then((cards) => {
    if (location.pathname === renderedFor) document.getElementById('page')?.append(...cards);
  }).catch(() => { /* 概览本身已经渲染完；细节取不到就不显示，不打断主内容 */ });
}

function overviewState(data) {
  const components = Object.values(data.components ?? {});
  const hasError = components.some((component) => component?.ok === false)
    || (data.attention ?? []).some((item) => item.severity === 'error');
  const hasWarning = (data.attention ?? []).some((item) => item.severity === 'warning');
  if (hasError) return {
    label: '需要处理',
    kind: 'bad',
    detail: 'At least one component is outside its expected state. Follow the linked item below before changing anything else.',
  };
  if (hasWarning) return {
    label: '建议查看',
    kind: 'warn',
    detail: 'The Framework is responding, but a recent change or development override deserves a deliberate review.',
  };
  return {
    label: '运行正常',
    kind: 'good',
    detail: 'Framework 正常响应，没有组件报告需要你处理的事项。',
  };
}

function statusRow(label, value, kind) {
  const row = valueRow(label, '');
  row.lastChild.replaceWith(text('b', value, `status ${kind}`));
  return row;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'n/a';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 60)}m`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function apiData(url, options) {
  const response = await api(url, options);
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const error = new Error(data.detail ?? data.error ?? `HTTP ${response.status}`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

const statusKind = (value) => {
  const state = String(value ?? '').toLowerCase();
  if (['ready', 'healthy', 'running', 'success', 'active', 'accepted', 'operational'].includes(state)) return 'good';
  if (['warning', 'degraded', 'review', 'review recommended'].includes(state)) return 'warn';
  if (['failed', 'unhealthy', 'exited', 'blocked', 'unavailable'].includes(state)) return 'bad';
  return 'neutral';
};

async function renderApplications() {
  const panel = section('已安装的应用');
  if (applicationNotice) panel.body.append(text('p', applicationNotice.text, `alert ${applicationNotice.kind}`));
  try {
    const result = await apiData('/api/apps');
    if (!result.apps?.length) panel.body.append(text('p', '还没有安装任何应用。', 'empty'));
    const apps = await Promise.all((result.apps ?? []).map(async (app) => {
      try {
        const packageInfo = await apiData(`/api/packages/${encodeURIComponent(app.package)}`);
        return { ...app, description: packageInfo.package?.manifest?.description ?? null };
      } catch { return { ...app, description: null }; }
    }));
    for (const app of apps) {
      const card = document.createElement('article');
      card.className = 'panel application-card';
      const head = document.createElement('div');
      head.className = 'application-card-head';
      const details = document.createElement('div');
      details.className = 'application-card-copy';
      details.append(text('b', app.name), text('small', `Package: ${app.package}`));
      const packageItem = {
        id: app.package,
        name: app.name,
        admin_title: app.name,
        enabled: app.enabled !== false,
        loader_status: app.state === 'ready' ? 'loaded' : app.state,
      };
      head.append(details, packageEnableToggle(packageItem, { after: renderApplications }));
      card.append(head, text('p', app.description ?? 'No package description was declared.', 'muted'));
      const controls = document.createElement('div');
      controls.className = 'button-row compact application-actions';
      controls.append(text('span', app.state.replaceAll('_', ' '), `status ${statusKind(app.state)}`));
      if (app.state === 'ready') {
        controls.append(linkButton('打开', app.url, 'primary', { newTab: true }));
      } else {
        controls.append(actionButton('打开', 'primary', () => openApplication(app), !canWrite() || app.state === 'disabled'));
      }
      card.append(controls);
      panel.body.append(card);
    }
  } catch (error) { componentError(panel.body, { error: String(error) }); }
  replacePage(panel.card);
}

async function openApplication(app) {
  const target = window.open('about:blank', '_blank');
  if (target) target.opener = null;
  try {
    let result = await apiData(`/api/apps/${encodeURIComponent(app.id)}/prepare`, { method: 'POST', body: '{}' });
    if (result.consent_required) {
      const accepted = await confirmAction({
        title: `Prepare ${app.name}`,
        label: '启动所需服务',
        details: [
          ['Application', app.name],
          ['Services to start', (result.start_services ?? []).map((s) => s.id).join(', ') || 'none'],
          ['Desired state', 'will be set to running by the existing Stage controller'],
        ],
      });
      if (!accepted) {
        target?.close();
        return;
      }
      result = await apiData(`/api/apps/${encodeURIComponent(app.id)}/prepare`, {
        method: 'POST', body: JSON.stringify({ approve_start: true }),
      });
    }
    for (let attempt = 0; !result.ready && result.state === 'warming' && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      result = await apiData(`/api/apps/${encodeURIComponent(app.id)}/prepare`, { method: 'POST', body: '{}' });
    }
    if (result.ready && result.url) {
      if (target && !target.closed) target.location.assign(result.url);
      else location.assign(result.url);
      return;
    }
    const setup = (result.components ?? []).find((item) => item.setup_url)?.setup_url;
    throw new Error(result.error ?? (setup ? `Required capability is unavailable; open ${setup}` : `Application is ${result.state ?? 'not ready'}`));
  } catch (error) {
    target?.close();
    applicationNotice = { kind: 'bad', text: `Could not open ${app.name}: ${error.message ?? error}` };
    renderApplications();
  }
}

async function renderServices() {
  const panel = section('受管服务');
  if (serviceNotice) panel.body.append(text('p', serviceNotice.text, `alert ${serviceNotice.kind}`));
  try {
    const result = await apiData('/api/stage/services');
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'data-table';
    const head = document.createElement('tr');
    for (const label of ['Name', 'Package', 'Desired', 'Process', 'Health', 'Last activity', 'Action']) head.append(text('th', label));
    const thead = document.createElement('thead'); thead.append(head); table.append(thead);
    const body = document.createElement('tbody');
    const cell = (label) => {
      const td = document.createElement('td');
      td.dataset.label = label;
      return td;
    };
    for (const service of result.services ?? []) {
      const row = document.createElement('tr');
      const name = cell('Service'); name.append(text('b', service.name), text('small', service.id));
      const pkg = cell('Package');
      if (service.package) {
        const link = document.createElement('a'); link.href = `/packages/${service.package}/`; link.textContent = service.package;
        pkg.append(link);
      } else pkg.append(text('span', 'Framework 核心', 'muted'));
      const desired = cell('Desired'); desired.append(text('span', service.desired ?? 'stopped', `status ${statusKind(service.desired)}`));
      const process = cell('进程'); process.append(text('span', service.process?.state ?? '未知', `status ${statusKind(service.process?.state)}`),
        text('small', service.process?.started_at ?? service.process?.exited_at ?? 'n/a'));
      const health = cell('健康'); health.append(text('span', service.health?.state ?? '未知', `status ${statusKind(service.health?.state)}`));
      const activity = cell('Last activity'); activity.append(text('span', service.last_activity_at ? new Date(service.last_activity_at).toLocaleString() : 'no log activity'));
      const actions = cell('Action'); actions.className = 'table-actions';
      for (const action of ['start', 'stop', 'restart']) {
        actions.append(actionButton(action[0].toUpperCase() + action.slice(1), action === 'stop' ? 'danger-text' : '',
          () => controlService(service, action), !canWrite()));
      }
      if (service.package) {
        actions.append(linkButton('打开', `/packages/${service.package}/`));
      }
      row.append(name, pkg, desired, process, health, activity, actions); body.append(row);
    }
    table.append(body); scroll.append(table); panel.body.append(scroll);
  } catch (error) { componentError(panel.body, { error: String(error) }); }
  replacePage(panel.card);
}

async function controlService(service, action) {
  const accepted = await confirmAction({
    title: `${action[0].toUpperCase() + action.slice(1)} ${service.name}`,
    label: action[0].toUpperCase() + action.slice(1),
    details: [
      ['Service', service.id],
      ['Package', service.package ?? 'Framework core'],
      ['Current desired state', service.desired ?? 'stopped'],
      ['Effect', action === 'stop' ? 'sets desired state to stopped' : 'uses the existing Stage service controller'],
    ],
  });
  if (!accepted) return;
  try {
    const result = await apiData(`/api/stage/services/${encodeURIComponent(service.id)}/${action}`, { method: 'POST', body: '{}' });
    serviceNotice = { kind: 'good', text: `${service.name}: ${action} ${result.changed ? 'completed' : 'was already in the requested state'}.` };
  } catch (error) {
    serviceNotice = { kind: 'bad', text: `${service.name}: ${error.message ?? error}` };
  }
  renderServices();
}

async function renderSystem() {
  const [overview, access] = await Promise.all([apiData('/api/admin/overview'), apiData('/api/access-info')]);
  const system = section('设备与 Framework');
  system.body.append(
    valueRow('设备', overview.system?.device),
    valueRow('平台', overview.system?.platform),
    valueRow('Framework 构建', overview.components?.framework?.value?.build),
    valueRow('Framework 版本', overview.components?.framework?.value?.version),
    valueRow('主要入口', access.primary?.admin_url ?? 'no reachable address reported'),
  );
  const resources = section('资源');
  const value = overview.components?.resources?.value;
  if (!overview.components?.resources?.ok) componentError(resources.body, overview.components?.resources ?? {});
  else resources.body.append(
    valueRow('内存', value.memory ? `${value.memory.available_mb} / ${value.memory.total_mb} MB free` : 'n/a'),
    valueRow('存储', value.storage?.sdcard ? `${value.storage.sdcard.free_gb} / ${value.storage.sdcard.total_gb} GB free` : 'n/a'),
    valueRow('温度', value.temperature ? `${value.temperature.celsius} °C` : 'n/a'),
    valueRow('设备已运行', formatDuration(value.device_uptime_s)),
  );
  replacePage(system.card, resources.card);
}

/**
 * 重启 Framework，然后把浏览器带到它重启后真正在听的地址。
 *
 * 改端口之后，当前这个页面的地址就失效了——原地重试只会一直失败，而用户看到的是
 * 「转圈然后打不开」，并不知道该去哪。所以这里主动探测新地址，通了就跳过去。
 */
async function restartFrameworkAndFollow({ portChangedTo = null } = {}) {
  const target = new URL(location.href);
  // 只有端口真的变了才改地址。
  //
  // 别把配置里的端口直接写进 URL：浏览器访问的端口不一定等于 Framework 监听的端口
  // ——中间可能隔着转发。真机上就是这样：控制台监听 8980，浏览器在 8981，改绑定地址
  // 时把 URL 改成 8980 会把用户送到一个打不开的地方。
  if (portChangedTo) target.port = String(portChangedTo);
  target.pathname = '/admin/system/administration';
  target.search = '';
  const overlay = document.createElement('div');
  overlay.className = 'reconnect-state';
  overlay.append(text('p', '正在重启 Framework…', 'alert warning'),
    text('small', `恢复后会自动打开 ${target.origin}`), document.createElement('progress'));
  replacePage(overlay);
  try {
    await apiData('/api/admin/restart', { method: 'POST', body: '{}' });
  } catch {
    // 重启请求本身可能在响应写完之前就断了，那不是失败。
  }
  const deadline = Date.now() + 60000;
  const probe = async () => {
    try {
      const response = await fetch(`${target.origin}/health`, { cache: 'no-store' });
      if (response.ok) { location.replace(target.href); return; }
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) {
      overlay.replaceChildren(
        text('p', 'Framework 在 60 秒内没有恢复。', 'alert error'),
        text('small', `请手动打开 ${target.origin}/admin`),
      );
      return;
    }
    setTimeout(probe, 1200);
  };
  setTimeout(probe, 2500);
}

/** 改绑定或改端口：说清后果 → 用户同意 → 写配置 → 立刻重启 → 跟到新地址。 */
async function applyNetworkChange(patch, net, prompt) {
  if (!confirm(`${prompt.title}？\n\n${prompt.body}\n\n更改后会立即重启 Framework。`)) return;
  let result;
  try {
    result = await apiData('/api/admin/network', { method: 'POST', body: JSON.stringify(patch) });
  } catch (error) {
    administrationNotice = { kind: 'bad', text: `设置失败：${error.message ?? error}` };
    return renderAdministration();
  }
  if (!result.restart_required) {
    administrationNotice = { kind: 'good', text: `已生效：${result.host}:${result.port}。` };
    return renderAdministration();
  }
  return restartFrameworkAndFollow({
    portChangedTo: result.port === net.running_port ? null : result.port,
  });
}

async function renderAdministration() {
  const [access, session, credentials] = await Promise.all([
    apiData('/api/access-info'), apiData('/api/auth/session'), apiData('/api/admin/credentials'),
  ]);
  const panel = section('控制台凭证');
  panel.body.append(text('p', 'System Key 是 Framework、Package 之间调用以及受信任第三方 App 共用的 API 凭证。这一页是控制中心，所以它显示在这里。', 'description'));
  if (administrationNotice) panel.body.append(text('p', administrationNotice.text, `alert ${administrationNotice.kind}`));

  const keyBlock = document.createElement('div'); keyBlock.className = 'credential-block';
  keyBlock.append(text('b', 'System Key / API 令牌'), text('p', credentials.note, 'muted'));
  const keyControls = document.createElement('div'); keyControls.className = 'credential-controls';
  const keyInput = document.createElement('input'); keyInput.type = 'text'; keyInput.value = '';
  keyInput.placeholder = credentials.system_key_masked ?? '***'; keyInput.readOnly = !credentials.editable;
  keyInput.autocomplete = 'off'; keyInput.spellcheck = false; keyInput.className = 'secret-input';
  const copy = actionButton('复制密钥', '', async () => {
    try {
      const full = await apiData('/api/admin/credentials/system-key');
      await navigator.clipboard.writeText(full.system_key);
      administrationNotice = { kind: 'good', text: 'System Key 已复制到剪贴板，屏幕上仍保持遮蔽。' };
    }
    catch { administrationNotice = { kind: 'warning', text: '剪贴板不可用，System Key 仍保持遮蔽状态。' }; }
    renderAdministration();
  });
  keyControls.append(keyInput, copy); keyBlock.append(keyControls);
  const keyActions = document.createElement('div'); keyActions.className = 'button-row';
  const saveKey = actionButton('保存手填密钥', 'primary', async () => {
    try {
      const result = await apiData('/api/admin/credentials/system-key', { method: 'POST', body: JSON.stringify({ value: keyInput.value }) });
      administrationNotice = { kind: 'good', text: `System Key saved. ${result.restarted_services?.length ?? 0} running Package service(s) restarted.` };
    } catch (error) { administrationNotice = { kind: 'bad', text: `System Key: ${error.message ?? error}` }; }
    renderAdministration();
  }, !canWrite() || !credentials.editable || !keyInput.value);
  keyInput.addEventListener('input', () => { saveKey.disabled = !canWrite() || !credentials.editable || !keyInput.value; });
  const generateKey = actionButton('生成随机密钥', '', async () => {
    try {
      await apiData('/api/admin/credentials/system-key', { method: 'POST', body: JSON.stringify({ generate: true }) });
      administrationNotice = { kind: 'good', text: '已生成新的随机 System Key。' };
    } catch (error) { administrationNotice = { kind: 'bad', text: `System Key: ${error.message ?? error}` }; }
    renderAdministration();
  }, !canWrite() || !credentials.editable);
  keyActions.append(saveKey, generateKey); keyBlock.append(keyActions);
  panel.body.append(keyBlock,
    valueRow('当前密钥', credentials.system_key_masked ?? '***'),
    valueRow('密钥长度', `${credentials.system_key_length} ${tr('个字符')}`),
    valueRow('凭证来源', credentials.source),
    valueRow('浏览器会话', `${session.schema ?? 'session'} · ${session.permissions?.join(', ') ?? 'n/a'}`),
    valueRow('会话到期', Number.isFinite(session.expires_in_seconds) ? `in ${formatDuration(session.expires_in_seconds)}` : 'n/a'),
  );

  const password = section('登录密码');
  // 本機進入面板本來就不需要密碼，再要求舊密碼只會擋住唯一有權改它的人。
  // 這個密碼是給別的設備用的——所以說清楚它擋的是誰。
  password.body.append(text('p', credentials.local
    ? '这个密码只在别的设备通过局域网访问时才需要；本机进入不用密码。改完后其他设备上的登录会失效。'
    : '设置新密码前先输入当前密码。更改成功后，已有的浏览器会话都会退出登录。',
  'description'));

  /**
   * ⭐ 一个失效的按钮必须说明它为什么失效。
   *
   * 这里原本只是把两个前置条件与起来传给 `disabled`，于是「凭证由外部管理」和
   * 「这个会话只读」在屏幕上长得一模一样——都是一个按不动的按钮，而两者要做的事
   * 完全不同。使用者唯一能得到的信息是「坏了」。
   */
  const blocked = !credentials.editable
    ? '凭证由 Framework 之外管理（环境变量或配置文件），面板改不了它——改动那个来源再重启。'
    : !canWrite() ? '当前浏览器会话是只读的。' : null;
  if (blocked) password.body.append(text('p', blocked, 'alert bad'));

  const minimumLength = credentials.login_password?.minimum_length ?? 16;
  const passwordForm = document.createElement('form'); passwordForm.className = 'credential-form';
  // ⚠ 明文，不遮蔽。遮蔽换来的是打错字看不见，而这里打错的后果是把自己关在面板外面。
  // 也因此不再要第二个确认栏：确认是遮蔽输入的补丁，值看得见时它只多一种失败方式。
  const currentPassword = document.createElement('input');
  currentPassword.type = 'text'; currentPassword.placeholder = '当前密码';
  currentPassword.required = !credentials.local; currentPassword.autocomplete = 'off';
  const newPassword = document.createElement('input');
  newPassword.type = 'text'; newPassword.placeholder = `新密码（至少 ${minimumLength} 个字符）`;
  newPassword.minLength = minimumLength; newPassword.required = true; newPassword.autocomplete = 'off';
  const savePassword = actionButton('更改登录密码', 'primary', null, Boolean(blocked), 'submit');
  if (!credentials.local) passwordForm.append(currentPassword);
  passwordForm.append(newPassword, savePassword);
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault(); savePassword.disabled = true;
    try {
      await apiData('/api/admin/credentials/login-password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword.value, new_password: newPassword.value }) });
      // 回 /admin 而不是登入頁：本機會就地重新取得 Session，別的設備才會看到登入框。
      location.replace('/admin');
    } catch (error) { administrationNotice = { kind: 'bad', text: `Login password: ${error.message ?? error}` }; renderAdministration(); }
  });
  password.body.append(passwordForm, valueRow('最短长度', `${minimumLength} ${tr('个字符')}`));

  // 语言放在这一页的最前面：它决定了下面所有内容用什么语言显示。
  const language = section('语言');
  const current = window.TermuxOSI18n?.language ?? 'zh-Hans';
  language.body.append(text('p', '切换后整个控制台立即改用所选语言。未翻译的条目会显示原文。', 'description'));
  const langForm = document.createElement('form'); langForm.className = 'inline-form';
  const select = document.createElement('select');
  select.id = 'ui-language';
  for (const item of window.TermuxOSI18n?.languages ?? []) {
    const option = document.createElement('option');
    option.value = item.code; option.textContent = item.label;
    option.selected = item.code === current;
    select.append(option);
  }
  select.disabled = !canWrite();
  const langLabel = document.createElement('label');
  langLabel.setAttribute('for', 'ui-language');
  langLabel.textContent = tr('界面语言');
  langForm.append(langLabel, select, actionButton('应用', 'primary', null, !canWrite(), 'submit'));
  langForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await apiData('/api/admin/ui', { method: 'POST', body: JSON.stringify({ language: select.value }) });
      await window.TermuxOSI18n.load(select.value);
      administrationNotice = { kind: 'good', text: '界面语言已更改。' };
    } catch (error) {
      administrationNotice = { kind: 'bad', text: `语言切换失败：${error.message ?? error}` };
    }
    // 重新渲染即可生效：文字全部经由组件产生，不需要重载页面。
    renderAdministration();
    await refreshAdminNavigation();
  });
  language.body.append(langForm);

  // 网络可达性放在地址清单之前：先决定绑在哪，那份清单才有意义。
  const network = section('网络访问');
  const net = await apiData('/api/admin/network').catch(() => null);
  if (!net) {
    network.body.append(text('p', '读不到当前的绑定地址。', 'alert error'));
  } else {
    network.body.append(
      // 整句写成一条字面量：跨行拼接的句子没法作为翻译词条，切了语言它会原样留着。
      text('p', '只监听 127.0.0.1 时，这个控制台只在这台设备上应答，本机进入不需要密码。开放局域网访问后，同一网络上的任何设备都能连上，登录密码是唯一的屏障。', 'description'),
      valueRow('监听地址', `${net.running_host}:${net.running_port}`),
    );
    if (net.restart_required) {
      network.body.append(text('p',
        `配置里已经是 ${net.host}:${net.port}，但运行中的还是 ${net.running_host}:${net.running_port}，重启后生效。`,
        'alert warning'));
    }
    // 两个动作放在同一行。各占一行会让这张卡片变成一列按钮，而它们是并列的选择。
    // 重启一直可用：它不只是「让改动生效」的一步，也是用户唯一能在浏览器里
    // 把卡住的 Framework 弄回来的手段。
    const lanRow = document.createElement('div');
    lanRow.className = 'button-row';
    lanRow.append(actionButton('重启框架', net.restart_required ? 'primary' : '',
      () => restartFrameworkAndFollow({ portChangedTo: net.port === net.running_port ? null : net.port }),
      !canWrite()));
    lanRow.append(actionButton(
      net.lan_enabled ? '改为只允许本机访问' : '允许局域网访问',
      net.lan_enabled ? '' : 'primary',
      () => applyNetworkChange(
        { lan_enabled: !net.lan_enabled },
        net,
        net.lan_enabled
          ? { title: '改为只允许本机访问', body: '改完之后，只有这台手机自己能打开控制台，其他设备会连不上。' }
          : { title: '允许局域网访问',
            body: '同一个网络上的任何设备都能打开这个控制台，唯一的屏障是登录密码。'
              + '开放之前请先确认密码不是系统生成的那一串随机字符。' }),
      !canWrite()));
    network.body.append(lanRow);

    // 端口会撞。撞了面板就打不开，而用户没有 shell 去改配置文件——所以这件事必须能在浏览器里做完。
    const portForm = document.createElement('form');
    portForm.className = 'inline-form';
    const portInput = document.createElement('input');
    portInput.type = 'number'; portInput.id = 'admin-port'; portInput.min = '1024'; portInput.max = '65535';
    portInput.value = String(net.port ?? 8980); portInput.required = true; portInput.disabled = !canWrite();
    const portLabel = document.createElement('label');
    portLabel.setAttribute('for', 'admin-port');
    portLabel.textContent = tr('控制台端口');
    portForm.append(portLabel, portInput, actionButton('更改端口', '', null, !canWrite(), 'submit'));
    portForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const port = Number(portInput.value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        administrationNotice = { kind: 'bad', text: '端口必须是 1024–65535 之间的整数。' };
        return renderAdministration();
      }
      if (port === Number(net.running_port)) {
        administrationNotice = { kind: 'good', text: `控制台已经在 ${port} 上监听。` };
        return renderAdministration();
      }
      return applyNetworkChange({ port }, net, {
        title: '更改控制台端口',
        body: `重启后控制台会改在 ${port} 端口上。当前这个地址会失效，`
          + '完成后浏览器会自动跳到新地址。小于 1024 的端口用不了，Termux 没有那个权限。',
      });
    });
    network.body.append(portForm);
  }

  // 只监听 loopback 时，别的地址上没有任何东西在听。把它们列出来只会让人照着打开、
  // 连不上，然后去查一个根本不存在的网络问题——所以那种情况下一条都不列。
  const listeningEverywhere = (net?.running_host ?? '127.0.0.1') === '0.0.0.0';
  const shown = (access.addresses ?? []).filter((item) => listeningEverywhere || item.kind === 'loopback');
  const addresses = section(listeningEverywhere ? '可访问地址' : '本机地址');
  if (!listeningEverywhere) {
    addresses.body.append(text('p',
      '控制台目前只在这台设备上应答。要让别的设备打得开，先用上面的「允许局域网访问」。', 'description'));
  }
  if (!shown.length) addresses.body.append(text('p', '当前没有可用地址。', 'empty'));
  for (const item of shown) {
    const link = document.createElement('a');
    link.className = 'list-link'; link.href = item.admin_url;
    link.append(text('b', item.admin_url), text('span', item.kind));
    addresses.body.append(link);
  }
  replacePage(language.card, panel.card, password.card, network.card, addresses.card);
}

async function copyText(textValue) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(textValue);
      return true;
    } catch { /* LAN HTTP and browser policy may require the selection fallback below. */ }
  }
  const input = document.createElement('textarea');
  input.value = textValue;
  input.readOnly = true;
  input.setAttribute('aria-hidden', 'true');
  input.className = 'copy-fallback';
  document.body.append(input);
  input.select();
  input.setSelectionRange(0, input.value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  input.remove();
  return copied;
}

// 状态总线：一个名字一个写入者。这里只做一件事——把「谁负责告诉大家什么、此刻是什么、
// 还可不可信」摆在同一行。不可观测的状态机会在第一次出问题时变成一个哑巴。
async function renderStates() {
  const data = await apiData('/api/states');
  const list = data.states ?? [];
  const card = section('状态信号');
  if (!list.length) {
    card.body.append(valueRow('已登记', '无 —— 还没有 Package 声明任何状态'));
    replacePage(card.card);
    return;
  }
  const byDomain = new Map();
  for (const state of list) {
    const domain = state.name.split('.')[0];
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(state);
  }
  const cards = [card.card];
  card.body.append(
    valueRow('已登记', `${list.length} 个`),
    valueRow('当前可信', `${list.filter((s) => s.live).length} 个`),
  );
  for (const [domain, group] of [...byDomain].sort()) {
    const block = section(`${domain}.*`);
    for (const state of group) {
      const shown = state.live
        ? String(state.value)
        : `${state.value === null ? '—' : state.value}（${state.stale_reason ?? 'not live'}）`;
      block.body.append(statusRow(
        state.name,
        shown,
        state.live ? 'ok' : 'warn',
      ));
      block.body.append(valueRow(
        '　由谁写入',
        `${state.owner?.package ?? '未知'}${state.owner?.service ? ` · ${state.owner.service}` : ''}`
        + ` · seq ${state.seq}`
        + (state.age_ms === null ? '' : ` · ${(state.age_ms / 1000).toFixed(1)}s 前`),
      ));
    }
    cards.push(block.card);
  }
  replacePage(...cards);
}

/**
 * 运行时的两张卡。
 *
 * ⭐ 它们不再有自己的分页。那一页上没有任何可做的操作——全是只读数字——所以它把
 * 「先看状态，再看原因」拆成了两次导航，而第二次导航之后能做的事仍然是零。
 * 概览已经在回答「现在怎么样」，这两张卡是同一个问题的下一层，放在它底下即可。
 */
async function runtimeCards(overviewData = null) {
  const [overview, integrity, dev] = await Promise.all([
    overviewData ? Promise.resolve(overviewData) : apiData('/api/admin/overview'),
    apiData('/api/admin/integrity'), apiData('/api/dev/packages'),
  ]);
  const framework = section('Framework 运行时');
  const report = overview.components?.framework?.value;
  framework.body.append(
    statusRow('健康', report?.health ?? '未知', statusKind(report?.health)),
    valueRow('构建', report?.build),
    valueRow('上次更新', report?.last_update ? `${stateWord(report.last_update.status)} · ${report.last_update.candidate_build ?? '未知'}` : '无'),
    valueRow('完整性', integrity.ok ? 'all core checks passed' : 'needs review'),
  );
  // Stage 服务不在这里列。「服务」有自己的分页，那里能启停、看健康、看日志；
  // 在运行时页再摆一份只读的同一批名字，读的人会以为这是另一样东西。
  const packages = section('Package 与开发运行时');
  const packageCheck = integrity.checks?.installed_packages;
  packages.body.append(
    valueRow('已加载的 Package', packageCheck ? `${packageCheck.loaded} / ${packageCheck.count}` : 'n/a'),
    valueRow('加载失败', packageCheck?.failed?.length ? packageCheck.failed.join(', ') : 'none'),
    valueRow('开发挂载', dev.mounts?.length ?? 0),
  );
  return [framework.card, packages.card];
}

function createObservationPanel(title = '日志观察') {
  const panel = section(title);
  panel.body.append(text('p', '「开始观察」只跟随新产生的日志。「清空视图」只清这个浏览器窗口，不会动已经存下来的日志。', 'description'));
  const controls = document.createElement('div'); controls.className = 'svc-controls';
  const select = document.createElement('select');
  const start = actionButton('开始观察', 'primary', startObservation);
  const clear = actionButton('清空视图', '', () => { log.textContent = ''; meta.textContent = `${tr('视图已清空，偏移量')} ${state.offset}`; }, true);
  const follow = document.createElement('label'); follow.className = 'meta';
  const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; follow.append(check, document.createTextNode(` ${tr('自动跟随')}`));
  const download = actionButton('下载当前日志', '', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([log.textContent], { type: 'text/plain;charset=utf-8' }));
    link.download = `observation-${state.component ?? 'log'}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click(); URL.revokeObjectURL(link.href);
  }, true);
  controls.append(select, start, clear, follow, download);
  const meta = text('p', '选择一个组件，然后开始观察。', 'meta');
  const log = document.createElement('pre'); log.className = 'logview';
  panel.body.append(controls, meta, log);
  const state = { component: null, offset: 0, timer: null };
  const loadComponents = async () => {
    try {
      const data = await apiData('/api/observation/components');
      const selected = select.value;
      select.replaceChildren(...(data.components ?? []).map((component) => Object.assign(document.createElement('option'), {
        value: component.id, textContent: component.id,
      })));
      if (selected && [...select.options].some((item) => item.value === selected)) select.value = selected;
    } catch (error) { meta.textContent = `${tr('读不到日志组件')}：${error.message ?? error}`; }
  };
  const poll = async () => {
    if (!state.component) return;
    try {
      const data = await apiData(`/api/observation/logs/${encodeURIComponent(state.component)}?after=${state.offset}`);
      if (data.reset) log.textContent = '';
      if (data.content) log.textContent = (log.textContent + data.content).slice(-200000);
      state.offset = data.size;
      const age = data.mtime_ms ? `${Math.max(0, Math.round((Date.now() - data.mtime_ms) / 1000))}s ago` : 'no log written';
      meta.textContent = `Observing ${state.component} · offset ${state.offset} · last write ${age}${data.skipped ? ` · skipped ${data.skipped} bytes` : ''}`;
      if (check.checked) log.scrollTop = log.scrollHeight;
    } catch { /* transient restart: next interval retries without declaring evidence lost */ }
  };
  async function startObservation() {
    if (!select.value) return;
    try {
      const data = await apiData('/api/observation', { method: 'POST', body: JSON.stringify({ component: select.value }) });
      state.component = data.observation.component; state.offset = data.observation.start_offset; log.textContent = '';
      clear.disabled = false; download.disabled = false; meta.textContent = `Observing ${state.component} from offset ${state.offset}.`;
      clearInterval(state.timer); state.timer = setInterval(poll, 2000);
    } catch (error) { meta.textContent = `Could not start observation: ${error.message ?? error}`; }
  }
  loadComponents();
  return { card: panel.card, cleanup: () => clearInterval(state.timer) };
}

async function renderLogs() {
  const observation = createObservationPanel('日志');
  // 生命周期作业与更新历史只在这里出现一次。先前 Package 的作业每个页面各挂一份，
  // 同一批作业重复四处，要查失败原因时反而不知道看哪一份；Framework 的则一直留在
  // 更新页上，让每次升级都先读一遍与决定无关的记录。
  let packageJobs = null;
  let frameworkOps = null;
  try {
    packageJobs = renderJobs(await apiData('/api/admin/package-manager'));
  } catch { /* 作业列表拿不到不该让日志页整页失败 */ }
  try {
    frameworkOps = renderFrameworkOperations(await apiData('/api/admin/framework-update'));
  } catch { /* 同上 */ }
  replacePage(observation.card, packageJobs, frameworkOps);
  pageCleanup = observation.cleanup;
}

/** 公開開發者入口。唯一有意義的一項，不值得占一個分頁，掛在 Workspace 標題行上。 */
function shareYourAppLink() {
  return linkButton('发布你的应用', 'https://package.termux-os.com/dev/', '', { newTab: true });
}

/**
 * Workspace page: one card per project directory under the workspace root.
 *
 * A workspace is a directory on disk; mounting is one of its properties, not its
 * existence. Listing only mounted projects meant a project the user had just created
 * was invisible until mounted, so the only way to know what existed was to open a
 * shell and run ls. Everything under the root is listed, and a mount living outside
 * the root is listed too so adopting the standard root loses nothing.
 *
 * The Shell renders the page title and its registry description, so this view adds no
 * heading of its own and uses valueRow() like every other administration page.
 */
async function renderWorkspace() {
  const data = await apiData('/api/admin/workspaces');
  const nodes = [];

  const head = section('项目');
  head.head?.append(actionButton('新建项目', 'primary', () => promptCreateWorkspace(data)), shareYourAppLink());
  head.body.append(valueRow('工作区根目录', data.root));
  if (!data.root_exists) {
    head.body.append(text('p', '这个目录还不存在，新建第一个项目时会自动创建。', 'empty'));
  }
  nodes.push(head.card);

  if (!data.projects?.length) {
    const empty = section('还没有项目');
    empty.body.append(text('p', '用「新建项目」从框架模板生成一个，或在已安装的 Package 卡片上点 Dev 派生一份。', 'empty'));
    nodes.push(empty.card);
    replacePage(...nodes);
    return;
  }

  for (const project of data.projects) {
    const card = section(project.name ? `${project.name} · ${project.slug}` : project.slug);
    card.body.append(valueRow('路径', project.path + (project.external ? '（在 workspace root 之外）' : '')));
    if (!project.valid) {
      card.body.append(text('p', `不是可掛載的專案：${project.invalid_reason}`, 'alert warning'));
    } else {
      card.body.append(
        valueRow('Package', `${project.package_id}${project.version ? ` · ${project.version}` : ''}`),
        valueRow('大小', formatBytes(project.size_bytes)),
      );
    }
    const mount = project.mount;
    card.body.append(valueRow('状态', mount
      ? `mounted @${mount.slug} · ${mount.status}${mount.error ? ` — ${mount.error}` : ''}`
      : 'not mounted'));
    if (mount) card.body.append(valueRow('监视', `${mount.watch_mode} · ${mount.seq ?? 0} reloads`));
    if (project.released) {
      card.body.append(valueRow('随同发布', `${project.released.version} (${project.released.status})`));
    }
    if (mount?.services?.length) {
      card.body.append(valueRow('服务', mount.services.map((sv) => `${sv.id} (${sv.state})`).join(', ')));
    }

    const row = document.createElement('div');
    row.className = 'button-row';
    if (mount) {
      // 按钮上只写动作。页面名称已经在上面的清单里列过，重复写进按钮只会把它撑得很长，
      // 而且几个按钮并排时，真正不同的那部分反而被前缀淹没。
      const pages = mount.pages ?? [];
      for (const page of pages) {
        row.append(pageLink(pages.length > 1 ? page.title : '打开', page.url, 'primary'));
      }
      if (project.released) row.append(pageLink('打开正式版', project.released.url));
      row.append(actionButton('停止挂载', '', () => workspaceMount(project, false)));
    } else {
      row.append(actionButton('挂载', 'primary', () => workspaceMount(project, true), !project.valid));
    }
    row.append(actionButton('打包', '', () => workspacePack(project), !project.valid || project.external));
    row.append(actionButton('删除', 'danger-text', () => workspaceDelete(project), Boolean(mount) || project.external));
    card.body.append(row);
    nodes.push(card.card);
  }

  replacePage(...nodes);
}

async function workspaceMount(project, mount) {
  try {
    if (mount) {
      await apiData('/api/dev/packages', { method: 'POST', body: JSON.stringify({
        package_id: project.package_id, workspace: project.path, slug: project.slug,
      }) });
    } else {
      await apiData(`/api/dev/packages/${encodeURIComponent(project.mount.instance_id)}/stop`, { method: 'POST', body: '{}' });
    }
    await refreshAdminNavigation();
  } catch (error) {
    alert(`${mount ? '挂载' : '停止挂载'}失败：${error.message ?? error}`);
  }
  return renderWorkspace();
}

/** 打包產物走瀏覽器下載：框架不碰共享儲存，字節由瀏覽器交給使用者的「下載」目錄。 */
async function workspacePack(project) {
  try {
    const response = await api(`/api/admin/workspaces/${encodeURIComponent(project.slug)}/pack`, { method: 'POST', body: '{}' });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail ?? detail.error ?? `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${project.package_id ?? project.slug}.tar.gz`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } catch (error) {
    alert(`打包失败：${error.message ?? error}`);
  }
}

async function workspaceDelete(project) {
  if (!confirm(`删除项目 ${project.slug}？\n\n${project.path}\n\n目录会被永久移除，此操作不可撤销。`)) return;
  try {
    await apiData(`/api/admin/workspaces/${encodeURIComponent(project.slug)}`, { method: 'DELETE' });
  } catch (error) {
    alert(`删除失败：${error.message ?? error}`);
  }
  return renderWorkspace();
}

/** 模板由框架擁有：它保證每個新專案都申報了框架管理所需的欄位。 */
async function promptCreateWorkspace() {
  const packageId = prompt('新项目的 Package ID\n例如 github.termux-os.service.my-thing');
  if (!packageId) return undefined;
  const type = prompt('类型：service / app / adapter / asset', 'service');
  if (!type) return undefined;
  const slug = packageId.split('.').pop();
  try {
    await apiData('/api/admin/workspaces', { method: 'POST', body: JSON.stringify({
      slug, package_id: packageId, type, name: slug,
    }) });
  } catch (error) {
    alert(`新建失败：${error.message ?? error}`);
  }
  return renderWorkspace();
}

/** 在新标签打开的按钮式链接。外观与其它按钮一致，只是它是导航而不是动作。 */
const pageLink = (label, href, variant = '') => linkButton(label, href, variant, { newTab: true });

/**
 * 变体名到组件 class 的映射。
 *
 * 过去按钮长什么样取决于它被放进了哪个容器（.button-row button、.upload-row button、
 * .table-actions button、.tabs button 各写一套），再加上 button-link / primary-link /
 * danger-text 几组并行的写法——同一个「更新」按钮在两个页面上是两个样子。现在外观只由
 * 变体决定，与位置无关；容器只负责排版。
 */
const BUTTON_VARIANT = {
  '': '', primary: 'is-primary', danger: 'is-danger', 'danger-text': 'is-danger-text',
  active: 'is-active', quiet: 'is-quiet',
};
const buttonClass = (variant) => ['btn', BUTTON_VARIANT[variant ?? ''] ?? String(variant ?? '')]
  .filter(Boolean).join(' ');

const actionButton = (label, className, handler, disabled = false, type = 'button') => {
  const button = document.createElement('button');
  button.type = type;
  button.textContent = tr(label);
  button.className = buttonClass(className);
  button.disabled = disabled;
  // A submit button inside a form is driven by the form's own handler.
  if (handler) button.addEventListener('click', handler);
  return button;
};

/** 外观与 actionButton 完全一致的链接：导航用 <a>，但它在界面上就是一个按钮。 */
const linkButton = (label, href, variant = '', { newTab = false } = {}) => {
  const link = document.createElement('a');
  link.href = href;
  link.textContent = tr(label);
  link.className = buttonClass(variant);
  if (newTab) { link.target = '_blank'; link.rel = 'noopener'; }
  return link;
};

function confirmAction({ title, label, details, acknowledgement = null }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-submit').textContent = label;
  $('confirm-details').replaceChildren(...details.map(([key, value]) => valueRow(key, value)));
  const ackWrap = $('confirm-ack-wrap');
  const ack = $('confirm-ack');
  const ackText = $('confirm-ack-text');
  ack.checked = false;
  ackWrap.hidden = !acknowledgement;
  ackText.textContent = acknowledgement ?? '';
  $('confirm-submit').disabled = Boolean(acknowledgement);
  const updateAck = () => { $('confirm-submit').disabled = Boolean(acknowledgement) && !ack.checked; };
  ack.addEventListener('change', updateAck);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      ack.removeEventListener('change', updateAck);
      ack.checked = false;
      $('confirm-submit').disabled = false;
      ackWrap.hidden = true;
      resolve(dialog.returnValue === 'confirm');
    }, { once: true });
    dialog.showModal();
  });
}

const jobLabel = (job) => job ? `${job.action} · ${job.stage} · ${job.status}` : 'n/a';
