/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The portrait Admin Shell renderers, shared card surfaces, and authenticated control actions.
 * [POS]: web/admin/app-core.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const $ = (id) => document.getElementById(id);
const api = (...args) => window.TermuxOS.api(...args);
const text = (tag, value, className) => Object.assign(document.createElement(tag), {
  textContent: value ?? 'n/a', className: className ?? '',
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
  $('breadcrumb').textContent = parent ? `${parent.title} / ${title}` : title;
  $('page-title').textContent = title;
  $('page-description').textContent = copySource?.description ?? 'This page uses the shared Browser Session and administration hierarchy.';
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
    top.textContent = node.title;
    top.addEventListener('click', () => setNavigationOpen(false));
    group.append(top);
    if (node.children?.length) {
      const list = document.createElement('div');
      list.className = 'nav-children';
      for (const child of node.children) {
        const link = document.createElement('a');
        const href = child.default_child ?? child.path;
        link.href = href;
        link.textContent = child.title;
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

const section = (title, href = null) => {
  const card = document.createElement('section');
  card.className = 'panel';
  const head = document.createElement('div');
  head.className = 'panel-head';
  head.append(text('h2', title));
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = 'Details';
    head.append(link);
  }
  const body = document.createElement('div');
  body.className = 'panel-body';
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
    text('p', 'CONTROL CENTER', 'eyebrow'),
    text('h2', state.label),
    text('p', state.detail, 'hero-description'),
  );
  const issues = document.createElement('div');
  issues.className = 'control-hero-issues';
  if (!data.attention.length) {
    issues.append(text('p', 'No action required. The control plane is within its expected state.', 'empty'));
  } else {
    issues.append(text('p', 'Action queue', 'control-hero-issues-label'));
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
    text('small', `Updated ${new Date(data.generated_at).toLocaleTimeString()}`, 'meta'),
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

  const app = section('Applications', '/admin/applications');
  if (!applications?.ok) componentError(app.body, applications);
  else {
    const v = applications.value;
    app.body.append(
      valueRow('Installed', v.installed),
      valueRow('Ready', v.loaded),
      valueRow('Disabled', v.disabled),
      valueRow('Attention', v.failed),
    );
  }

  const svc = section('Services', '/admin/services/overview');
  if (!services.ok) componentError(svc.body, services);
  else {
    const v = services.value;
    svc.body.append(
      valueRow('Running', v.running),
      valueRow('Stopped', v.stopped),
      valueRow('Failed', v.failed),
      valueRow('Registered', v.total),
    );
  }

  const pkg = section('Packages', '/admin/packages/overview');
  if (!packages.ok) componentError(pkg.body, packages);
  else {
    const v = packages.value;
    pkg.body.append(
      valueRow('Installed', v.installed),
      valueRow('Loaded', v.loaded),
      valueRow('Failed / degraded', `${v.failed} / ${v.degraded}`),
      valueRow('Updates', v.available_updates ?? 'n/a'),
    );
  }

  const adapter = section('Adapters', '/admin/adapters/overview');
  if (!adapters?.ok) componentError(adapter.body, adapters);
  else {
    const v = adapters.value;
    adapter.body.append(
      valueRow('Installed', v.installed),
      valueRow('Ready', v.loaded),
      valueRow('Disabled', v.disabled),
      valueRow('Attention', v.failed),
    );
  }

  const sys = section('System', '/admin/system/system');
  sys.body.append(
    valueRow('Device', data.system.device),
    valueRow('Platform', data.system.platform),
    valueRow('Android', data.system.android),
    valueRow('Termux', data.system.termux_prefix),
    valueRow('Current time', new Date(data.generated_at).toLocaleString()),
    valueRow('Framework uptime', resources.ok ? formatDuration(resources.value.framework_uptime_s) : 'n/a'),
  );
  if (!resources.ok) componentError(sys.body, resources);
  else {
    const m = resources.value;
    sys.body.append(
      valueRow('Memory', m.memory ? `${m.memory.available_mb} MB available of ${m.memory.total_mb} MB` : 'n/a'),
      valueRow('Storage', m.storage?.sdcard ? `${m.storage.sdcard.free_gb} GB available of ${m.storage.sdcard.total_gb} GB` : 'n/a'),
      valueRow('CPU', m.cpu?.usage_percent == null ? `${m.cpu?.cores ?? 'n/a'} cores · load n/a` : `${m.cpu.usage_percent}% · ${m.cpu.cores} cores`),
      valueRow('Temperature', m.temperature ? `${m.temperature.celsius} °C` : 'n/a'),
      valueRow('Device uptime', formatDuration(m.device_uptime_s)),
    );
  }
  if (!framework.ok) componentError(sys.body, framework);
  else {
    const v = framework.value;
    sys.body.append(
      statusRow('Framework health', v.health, v.health === 'healthy' ? 'good' : 'bad'),
      valueRow('Framework version', v.version),
      valueRow('Framework build', v.build),
      valueRow('Last update', v.last_update ? `${v.last_update.status} · ${v.last_update.candidate_build ?? 'unknown build'}` : 'none recorded'),
    );
  }
  grid.append(app.card, svc.card, pkg.card, adapter.card, sys.card);
  replacePage(hero, grid);
}

function overviewState(data) {
  const components = Object.values(data.components ?? {});
  const hasError = components.some((component) => component?.ok === false)
    || (data.attention ?? []).some((item) => item.severity === 'error');
  const hasWarning = (data.attention ?? []).some((item) => item.severity === 'warning');
  if (hasError) return {
    label: 'Needs attention',
    kind: 'bad',
    detail: 'At least one component is outside its expected state. Follow the linked item below before changing anything else.',
  };
  if (hasWarning) return {
    label: 'Review recommended',
    kind: 'warn',
    detail: 'The Framework is responding, but a recent change or development override deserves a deliberate review.',
  };
  return {
    label: 'Operational',
    kind: 'good',
    detail: 'The Framework is responding and no component has reported an action requiring your attention.',
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
  const panel = section('Installed applications');
  if (applicationNotice) panel.body.append(text('p', applicationNotice.text, `alert ${applicationNotice.kind}`));
  try {
    const result = await apiData('/api/apps');
    if (!result.apps?.length) panel.body.append(text('p', 'No applications are installed.', 'empty'));
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
        const open = document.createElement('a');
        open.href = app.url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.className = 'button-link primary-link';
        open.textContent = 'Open';
        controls.append(open);
      } else {
        controls.append(actionButton('Open', 'primary', () => openApplication(app), !canWrite() || app.state === 'disabled'));
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
        label: 'Start required services',
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
  const panel = section('Managed services');
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
      } else pkg.append(text('span', 'Framework core', 'muted'));
      const desired = cell('Desired'); desired.append(text('span', service.desired ?? 'stopped', `status ${statusKind(service.desired)}`));
      const process = cell('Process'); process.append(text('span', service.process?.state ?? 'unknown', `status ${statusKind(service.process?.state)}`),
        text('small', service.process?.started_at ?? service.process?.exited_at ?? 'n/a'));
      const health = cell('Health'); health.append(text('span', service.health?.state ?? 'unknown', `status ${statusKind(service.health?.state)}`));
      const activity = cell('Last activity'); activity.append(text('span', service.last_activity_at ? new Date(service.last_activity_at).toLocaleString() : 'no log activity'));
      const actions = cell('Action'); actions.className = 'table-actions';
      for (const action of ['start', 'stop', 'restart']) {
        actions.append(actionButton(action[0].toUpperCase() + action.slice(1), action === 'stop' ? 'danger-text' : '',
          () => controlService(service, action), !canWrite()));
      }
      if (service.package) {
        const open = document.createElement('a'); open.href = `/packages/${service.package}/`; open.className = 'button-link'; open.textContent = 'Open'; actions.append(open);
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
  const system = section('Device and Framework');
  system.body.append(
    valueRow('Device', overview.system?.device),
    valueRow('Platform', overview.system?.platform),
    valueRow('Framework build', overview.components?.framework?.value?.build),
    valueRow('Framework version', overview.components?.framework?.value?.version),
    valueRow('Primary access', access.primary?.admin_url ?? 'no reachable address reported'),
  );
  const resources = section('Resources');
  const value = overview.components?.resources?.value;
  if (!overview.components?.resources?.ok) componentError(resources.body, overview.components?.resources ?? {});
  else resources.body.append(
    valueRow('Memory', value.memory ? `${value.memory.available_mb} / ${value.memory.total_mb} MB free` : 'n/a'),
    valueRow('Storage', value.storage?.sdcard ? `${value.storage.sdcard.free_gb} / ${value.storage.sdcard.total_gb} GB free` : 'n/a'),
    valueRow('Temperature', value.temperature ? `${value.temperature.celsius} °C` : 'n/a'),
    valueRow('Device uptime', formatDuration(value.device_uptime_s)),
  );
  replacePage(system.card, resources.card);
}

async function renderAdministration() {
  const [access, session, credentials] = await Promise.all([
    apiData('/api/access-info'), apiData('/api/auth/session'), apiData('/api/admin/credentials'),
  ]);
  const panel = section('Control-center credentials');
  panel.body.append(text('p', 'The System Key is the shared API credential for the Framework, Package-to-Package calls, and trusted third-party Apps. It is shown here because this page is the control center.', 'description'));
  if (administrationNotice) panel.body.append(text('p', administrationNotice.text, `alert ${administrationNotice.kind}`));

  const keyBlock = document.createElement('div'); keyBlock.className = 'credential-block';
  keyBlock.append(text('b', 'System Key / API token'), text('p', credentials.note, 'muted'));
  const keyControls = document.createElement('div'); keyControls.className = 'credential-controls';
  const keyInput = document.createElement('input'); keyInput.type = 'text'; keyInput.value = '';
  keyInput.placeholder = credentials.system_key_masked ?? '***'; keyInput.readOnly = !credentials.editable;
  keyInput.autocomplete = 'off'; keyInput.spellcheck = false; keyInput.className = 'secret-input';
  const copy = actionButton('Copy key', '', async () => {
    try {
      const full = await apiData('/api/admin/credentials/system-key');
      await navigator.clipboard.writeText(full.system_key);
      administrationNotice = { kind: 'good', text: 'System Key copied to the clipboard; the full value stays masked on screen.' };
    }
    catch { administrationNotice = { kind: 'warning', text: 'Clipboard access was unavailable. The full System Key remains masked.' }; }
    renderAdministration();
  });
  keyControls.append(keyInput, copy); keyBlock.append(keyControls);
  const keyActions = document.createElement('div'); keyActions.className = 'button-row';
  const saveKey = actionButton('Save manual key', 'primary', async () => {
    try {
      const result = await apiData('/api/admin/credentials/system-key', { method: 'POST', body: JSON.stringify({ value: keyInput.value }) });
      administrationNotice = { kind: 'good', text: `System Key saved. ${result.restarted_services?.length ?? 0} running Package service(s) restarted.` };
    } catch (error) { administrationNotice = { kind: 'bad', text: `System Key: ${error.message ?? error}` }; }
    renderAdministration();
  }, !canWrite() || !credentials.editable || !keyInput.value);
  keyInput.addEventListener('input', () => { saveKey.disabled = !canWrite() || !credentials.editable || !keyInput.value; });
  const generateKey = actionButton('Generate random key', '', async () => {
    try {
      await apiData('/api/admin/credentials/system-key', { method: 'POST', body: JSON.stringify({ generate: true }) });
      administrationNotice = { kind: 'good', text: 'A new random System Key was generated.' };
    } catch (error) { administrationNotice = { kind: 'bad', text: `System Key: ${error.message ?? error}` }; }
    renderAdministration();
  }, !canWrite() || !credentials.editable);
  keyActions.append(saveKey, generateKey); keyBlock.append(keyActions);
  panel.body.append(keyBlock,
    valueRow('Current key', credentials.system_key_masked ?? '***'),
    valueRow('Key length', `${credentials.system_key_length} characters`),
    valueRow('Credential source', credentials.source),
    valueRow('Browser Session', `${session.schema ?? 'session'} · ${session.permissions?.join(', ') ?? 'n/a'}`),
    valueRow('Session expires', Number.isFinite(session.expires_in_seconds) ? `in ${formatDuration(session.expires_in_seconds)}` : 'n/a'),
  );

  const password = section('Login password');
  password.body.append(text('p', 'Enter the current password before setting a new one. Existing Browser Sessions are signed out after a successful change.', 'description'));
  const passwordForm = document.createElement('form'); passwordForm.className = 'credential-form';
  const currentPassword = document.createElement('input'); currentPassword.type = 'password'; currentPassword.placeholder = 'Current password'; currentPassword.required = true; currentPassword.autocomplete = 'current-password';
  const newPassword = document.createElement('input'); newPassword.type = 'password'; newPassword.placeholder = 'New password'; newPassword.minLength = credentials.login_password?.minimum_length ?? 16; newPassword.autocomplete = 'new-password';
  const confirmPassword = document.createElement('input'); confirmPassword.type = 'password'; confirmPassword.placeholder = 'Repeat new password'; confirmPassword.minLength = newPassword.minLength; confirmPassword.autocomplete = 'new-password';
  const savePassword = actionButton('Update login password', 'primary', () => {}, !canWrite() || !credentials.editable);
  savePassword.type = 'submit';
  passwordForm.append(currentPassword, newPassword, confirmPassword, savePassword);
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault(); savePassword.disabled = true;
    try {
      await apiData('/api/admin/credentials/login-password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword.value, new_password: newPassword.value, confirm_password: confirmPassword.value }) });
      location.replace('/admin/login');
    } catch (error) { administrationNotice = { kind: 'bad', text: `Login password: ${error.message ?? error}` }; renderAdministration(); }
  });
  password.body.append(passwordForm, valueRow('Minimum length', `${credentials.login_password?.minimum_length ?? 16} characters`));

  // 網路可達性放在「Reachable addresses」之前：先決定綁在哪，那份清單才有意義。
  const network = section('Network access');
  const net = await apiData('/api/admin/network').catch(() => null);
  if (!net) {
    network.body.append(text('p', 'Could not read the current bind address.', 'alert error'));
  } else {
    network.body.append(
      text('p', 'Loopback only means this control center answers on this device alone. Allowing LAN access lets any device on the same network reach it, with the login password as the only barrier.', 'description'),
      valueRow('Configured bind', `${net.host}:${net.port}`),
      valueRow('Currently listening on', net.running_host),
    );
    if (net.restart_required) {
      network.body.append(text('p', 'The configured address differs from the running one. Restart to apply it.', 'alert warning'));
    }
    // 生效需要重啟，而重啟必須能在瀏覽器裡完成——讓使用者為了套用一個設定去開 Termux，
    // 等於把這個開關做了一半。
    const restartRow = document.createElement('div');
    restartRow.className = 'button-row';
    restartRow.append(actionButton('重启框架', net.restart_required ? 'primary' : '', async () => {
      if (!confirm('重启 Framework？\n\n控制台会短暂中断，数秒后恢复。')) return;
      try {
        await apiData('/api/admin/restart', { method: 'POST', body: '{}' });
        administrationNotice = { kind: 'good', text: '正在重启；数秒后请重新整理页面。' };
      } catch (error) {
        administrationNotice = { kind: 'bad', text: `重启失败：${error.message ?? error}` };
      }
      renderAdministration();
    }, !canWrite()));
    network.body.append(restartRow);
    const toggle = document.createElement('label');
    toggle.className = 'enable-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = net.lan_enabled;
    input.disabled = !canWrite();
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        const result = await apiData('/api/admin/network', {
          method: 'POST', body: JSON.stringify({ lan_enabled: input.checked }),
        });
        administrationNotice = { kind: result.restart_required ? 'warning' : 'good',
          text: result.restart_required
            ? `Bind address set to ${result.host}. Restart the Framework to apply it.`
            : `Bind address is ${result.host}.` };
      } catch (error) {
        administrationNotice = { kind: 'bad', text: `Network access: ${error.message ?? error}` };
      }
      renderAdministration();
    });
    toggle.append(input, text('span', 'Allow access from the local network (0.0.0.0)'));
    network.body.append(toggle);
  }

  const addresses = section('Reachable addresses');
  if (!access.addresses?.length) addresses.body.append(text('p', 'No non-loopback address is currently reported.', 'empty'));
  for (const item of access.addresses ?? []) {
    const link = document.createElement('a');
    link.className = 'list-link'; link.href = item.admin_url;
    link.append(text('b', item.admin_url), text('span', item.kind));
    addresses.body.append(link);
  }
  replacePage(panel.card, password.card, network.card, addresses.card);
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

async function renderRuntime() {
  const [overview, integrity, stage, dev] = await Promise.all([
    apiData('/api/admin/overview'), apiData('/api/admin/integrity'), apiData('/api/stage/services'), apiData('/api/dev/packages'),
  ]);
  const framework = section('Framework runtime');
  const report = overview.components?.framework?.value;
  framework.body.append(
    statusRow('Health', report?.health ?? 'unknown', statusKind(report?.health)),
    valueRow('Build', report?.build),
    valueRow('Last update', report?.last_update ? `${report.last_update.status} · ${report.last_update.candidate_build ?? 'n/a'}` : 'none'),
    valueRow('Integrity', integrity.ok ? 'all core checks passed' : 'needs review'),
  );
  const services = section('Stage services');
  for (const item of stage.services ?? []) {
    services.body.append(statusRow(item.name, `${item.desired} → ${item.process?.state} / ${item.health?.state}`,
      item.process?.state === 'running' && item.health?.state !== 'unhealthy' ? 'good' : statusKind(item.process?.state)));
  }
  const packages = section('Package and Dev Runtime');
  const packageCheck = integrity.checks?.installed_packages;
  packages.body.append(
    valueRow('Loaded packages', packageCheck ? `${packageCheck.loaded} / ${packageCheck.count}` : 'n/a'),
    valueRow('Load failures', packageCheck?.failed?.length ? packageCheck.failed.join(', ') : 'none'),
    valueRow('Dev Mounts', dev.mounts?.length ?? 0),
  );
  replacePage(framework.card, services.card, packages.card);
}

function createObservationPanel(title = 'Log observation') {
  const panel = section(title);
  panel.body.append(text('p', 'Start Observation only follows new log output. Clear View changes this browser view, never the stored log evidence.', 'description'));
  const controls = document.createElement('div'); controls.className = 'svc-controls';
  const select = document.createElement('select');
  const start = actionButton('Start Observation', 'primary', startObservation);
  const clear = actionButton('Clear View', '', () => { log.textContent = ''; meta.textContent = `View cleared at offset ${state.offset}.`; }, true);
  const follow = document.createElement('label'); follow.className = 'meta';
  const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; follow.append(check, document.createTextNode(' Auto Follow'));
  const download = actionButton('Download visible log', '', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([log.textContent], { type: 'text/plain;charset=utf-8' }));
    link.download = `observation-${state.component ?? 'log'}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click(); URL.revokeObjectURL(link.href);
  }, true);
  controls.append(select, start, clear, follow, download);
  const meta = text('p', 'Choose a component and start an observation.', 'meta');
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
    } catch (error) { meta.textContent = `Could not load log components: ${error.message ?? error}`; }
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
  const observation = createObservationPanel('Logs');
  // Package 生命週期作業只在這裡出現一次；先前每個 Package 頁面各掛一份，
  // 同一批作業重複四處，要查失敗原因時反而不知道看哪一份。
  let jobs = null;
  try {
    jobs = renderJobs(await apiData('/api/admin/package-manager'));
  } catch { /* 作業列表拿不到不該讓日誌頁整頁失敗 */ }
  replacePage(observation.card, jobs);
  pageCleanup = observation.cleanup;
}

/** 公開開發者入口。唯一有意義的一項，不值得占一個分頁，掛在 Workspace 標題行上。 */
function shareYourAppLink() {
  const link = document.createElement('a');
  link.href = 'https://package.termux-os.com/dev/';
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = 'button-link';
  link.textContent = 'Share your App';
  return link;
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

  const head = section('Projects');
  head.head?.append(actionButton('新建项目', 'primary', () => promptCreateWorkspace(data)), shareYourAppLink());
  head.body.append(valueRow('Workspace root', data.root));
  if (!data.root_exists) {
    head.body.append(text('p', '这个目录还不存在，新建第一个项目时会自动创建。', 'empty'));
  }
  nodes.push(head.card);

  if (!data.projects?.length) {
    const empty = section('No project yet');
    empty.body.append(text('p', '用「新建项目」从框架模板生成一个，或在已安装的 Package 卡片上点 Dev 派生一份。', 'empty'));
    nodes.push(empty.card);
    replacePage(...nodes);
    return;
  }

  for (const project of data.projects) {
    const card = section(project.name ? `${project.name} · ${project.slug}` : project.slug);
    card.body.append(valueRow('Path', project.path + (project.external ? '（在 workspace root 之外）' : '')));
    if (!project.valid) {
      card.body.append(text('p', `不是可掛載的專案：${project.invalid_reason}`, 'alert warning'));
    } else {
      card.body.append(
        valueRow('Package', `${project.package_id}${project.version ? ` · ${project.version}` : ''}`),
        valueRow('Size', formatBytes(project.size_bytes)),
      );
    }
    const mount = project.mount;
    card.body.append(valueRow('State', mount
      ? `mounted @${mount.slug} · ${mount.status}${mount.error ? ` — ${mount.error}` : ''}`
      : 'not mounted'));
    if (mount) card.body.append(valueRow('Watch', `${mount.watch_mode} · ${mount.seq ?? 0} reloads`));
    if (project.released) {
      card.body.append(valueRow('Released alongside', `${project.released.version} (${project.released.status})`));
    }
    if (mount?.services?.length) {
      card.body.append(valueRow('Services', mount.services.map((sv) => `${sv.id} (${sv.state})`).join(', ')));
    }

    const row = document.createElement('div');
    row.className = 'button-row';
    if (mount) {
      for (const page of mount.pages ?? []) {
        row.append(pageLink(`打开 ${page.title}`, page.url, 'button-link primary-link'));
      }
      if (project.released) row.append(pageLink(`打开正式版 ${project.released.version}`, project.released.url, 'button-link'));
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

const pageLink = (label, href, className) => {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = className;
  link.textContent = label;
  return link;
};

const actionButton = (label, className, handler, disabled = false) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = className ?? '';
  button.disabled = disabled;
  button.addEventListener('click', handler);
  return button;
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
