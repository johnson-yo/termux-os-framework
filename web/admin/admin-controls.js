/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: Mobile Package Manager cards, pre-download details, and explicit safety-confirmed install actions.
 * [POS]: web/admin/admin-controls.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const frameworkUpdateKind = (state) => {
  if (state?.status === 'success') return 'good';
  if (['failed', 'failed_rolled_back'].includes(state?.status)) return 'bad';
  return 'neutral';
};

function frameworkJobCard(job) {
  const details = document.createElement('details'); details.className = 'job-row';
  if (['queued', 'running'].includes(job.status)) details.open = true;
  const summary = document.createElement('summary');
  summary.append(text('b', `${job.action} · ${job.target?.upload_id ?? 'last-good'}`),
    text('span', `${job.stage} · ${job.status}`, `status ${frameworkUpdateKind(job)}`));
  details.append(summary);
  if (['queued', 'running'].includes(job.status)) details.append(document.createElement('progress'));
  if (job.output) details.append(text('pre', job.output));
  if (job.error) details.append(text('p', job.error, 'alert error'));
  return details;
}
function frameworkHistoryCard(entry) {
  const row = document.createElement('details'); row.className = 'job-row';
  const summary = document.createElement('summary');
  summary.append(text('b', `${entry.previous_build ?? 'unknown'} → ${entry.candidate_build ?? 'unknown'}`),
    text('span', `${entry.result}${entry.rollback ? ' · rollback' : ''}`, `status ${entry.result === 'success' ? 'good' : 'bad'}`));
  row.append(summary, text('p', entry.message ?? 'No message recorded.', 'meta'),
    text('small', entry.at ? new Date(entry.at).toLocaleString() : 'n/a'));
  return row;
}

function showManualDownloadDialog({ title, manual, nextStep }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog manual-download-dialog';
    const form = document.createElement('form'); form.method = 'dialog';
    const heading = document.createElement('h2'); heading.textContent = title;
    const intro = text('p', 'The direct GitHub source and the Termux-OS Registry could not be downloaded. Copy the GitHub Release page URL, download the verified .tar.gz yourself, then return here and install the file.', 'description');
    const label = document.createElement('label'); label.textContent = 'GitHub Release page';
    const row = document.createElement('div'); row.className = 'manual-download-url-row';
    const input = document.createElement('input'); input.type = 'text'; input.value = manual.release_url; input.readOnly = true; input.select();
    const copy = actionButton('Copy URL', '', async () => {
      const copied = await copyText(manual.release_url);
      copy.textContent = copied ? 'Copied' : 'Select and copy';
      if (!copied) { input.focus(); input.select(); }
    });
    row.append(input, copy);
    const link = document.createElement('a'); link.href = manual.release_url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open Release page'; link.className = 'button-link';
    form.append(heading, intro, label, row, link, text('p', nextStep, 'alert warning'));
    const actions = document.createElement('div'); actions.className = 'button-row';
    actions.append(actionButton('Close', '', () => dialog.close('close')));
    form.append(actions); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(); }, { once: true });
    dialog.showModal();
  });
}

async function runFrameworkPreflight(upload) {
  try {
    const result = await apiData(`/api/admin/framework-update/uploads/${encodeURIComponent(upload.id)}/preflight`, {
      method: 'POST', body: '{}',
    });
    frameworkUpdateNotice = { kind: 'good', text: `Started the check for ${upload.original_name}: ${jobLabel(result.job)}.` };
  } catch (error) {
    frameworkUpdateNotice = { kind: 'bad', text: `Check: ${error.message ?? error}` };
  }
  await loadFrameworkUpdate();
}

async function runFrameworkUpdate(upload, currentBuild) {
  const accepted = await confirmAction({
    title: 'Install Framework update',
    label: 'Update Framework',
    details: [
      ['Current build', currentBuild ?? 'unknown'],
      ['Update file', upload.original_name],
      ['Update build', upload.preflight?.candidate_build ?? 'validated by formal check'],
      ['File SHA-256', upload.sha256],
      ['Preserved', 'Installed Packages, persistent config/data and assets'],
      ['Success check', 'Browser Login, admin menu, integrity, Package inventory and boundary comparison'],
      ['Failure behavior', 'the existing engine automatically restores the previous version and records the evidence'],
    ],
  });
  if (!accepted) return;
  try {
    const result = await apiData(`/api/admin/framework-update/uploads/${encodeURIComponent(upload.id)}/update`, {
      method: 'POST', body: JSON.stringify({ confirm_sha256: upload.sha256 }),
    });
    frameworkUpdateNotice = { kind: 'good', text: `Started ${jobLabel(result.job)}. Framework will reconnect to its persistent update result.` };
  } catch (error) {
    frameworkUpdateNotice = { kind: 'bad', text: `Update: ${error.message ?? error}` };
  }
  await loadFrameworkUpdate();
}

async function runFrameworkRollback(lastGood, currentBuild) {
  const accepted = await confirmAction({
    title: 'Restore previous Framework version',
    label: 'Restore',
    details: [
      ['Current build', currentBuild ?? 'unknown'],
      ['Restore previous version', lastGood.build],
      ['Preserved', 'Installed Packages, persistent config/data and assets'],
      ['Success check', 'the existing engine repeats core and boundary checks'],
      ['Failure behavior', 'the existing engine restores the operation-start runtime when possible'],
    ],
  });
  if (!accepted) return;
  try {
    const result = await apiData('/api/admin/framework-update/rollback', {
      method: 'POST', body: JSON.stringify({ confirm_last_good_build: lastGood.build }),
    });
    frameworkUpdateNotice = { kind: 'good', text: `Started ${jobLabel(result.job)}. Framework will reconnect to its persistent update result.` };
  } catch (error) {
    frameworkUpdateNotice = { kind: 'bad', text: `Rollback: ${error.message ?? error}` };
  }
  await loadFrameworkUpdate();
}

async function runFrameworkRegistryUpdate(registry, currentBuild) {
  const file = registry.file ?? {};
  const accepted = await confirmAction({
    title: 'Install Framework update',
    label: 'Download and update',
    details: [
      ['Current version', currentBuild ?? registry.current_version ?? 'unknown'],
      ['New version', registry.latest_version],
      ['Source', `${registry.repository} · ${registry.selection?.upstream_ref ?? 'verified Registry source'}`],
      ['Size', formatBytes(file.size)],
      ['File SHA-256', file.sha256 ?? 'not available'],
    ['Update path', 'download through Package Registry, then independent installer'],
      ['Preserved', 'Framework configuration, credentials, Packages, models and caches'],
      ['Failure behavior', 'installer restores the previous runtime before reporting failure'],
    ],
  });
  if (!accepted) return;
  try {
    const result = await apiData('/api/admin/framework-update/registry', {
      method: 'POST', body: JSON.stringify({ confirm_version: registry.latest_version }),
    });
    frameworkUpdateNotice = { kind: 'good', text: `Downloaded ${registry.latest_version}; ${jobLabel(result.job)} is installing it.` };
  } catch (error) {
    if (error?.data?.manual?.release_url) {
      await showManualDownloadDialog({
        title: 'Download Framework update manually',
        manual: error.data.manual,
        nextStep: 'After transferring the archive to this device, use Update files → Upload update file, run the check, and then update Framework.',
      });
    }
    frameworkUpdateNotice = { kind: 'bad', text: `Registry update: ${error.message ?? error}` };
  }
  await loadFrameworkUpdate();
}

function frameworkUploadCard(upload, currentBuild, disabled) {
  const card = document.createElement('section'); card.className = 'release-card';
  card.append(text('b', upload.original_name), text('code', upload.sha256),
    valueRow('Size', formatBytes(upload.size)),
    statusRow('Check', upload.status.replaceAll('_', ' '),
      upload.status === 'preflight_passed' || upload.status === 'applied' ? 'good'
        : upload.status === 'preflight_failed' ? 'bad' : 'neutral'));
  if (upload.preflight?.candidate_build) card.append(valueRow('Update build', upload.preflight.candidate_build));
  const controls = document.createElement('div'); controls.className = 'button-row';
  if (['uploaded', 'preflight_failed'].includes(upload.status)) {
    controls.append(actionButton('Run check', '', () => runFrameworkPreflight(upload), disabled));
  }
  if (upload.status === 'preflight_passed') {
    controls.append(actionButton('Update Framework', 'primary', () => runFrameworkUpdate(upload, currentBuild), disabled));
  }
  if (upload.preflight?.output) {
    const output = document.createElement('details');
    output.append(Object.assign(document.createElement('summary'), { textContent: 'Check details' }), text('pre', upload.preflight.output));
    card.append(output);
  }
  card.append(controls);
  return card;
}

function renderFrameworkUpdate(data) {
  if (frameworkUpdatePollTimer) { clearTimeout(frameworkUpdatePollTimer); frameworkUpdatePollTimer = null; }
  frameworkUpdateReconnectSince = 0;
  const update = section('Framework Update');
  update.body.append(text('p', 'Upload an update file here. The Framework checks it first, then updates or restores the previous version.', 'description'));
  if (frameworkUpdateNotice) update.body.append(text('p', frameworkUpdateNotice.text, `alert ${frameworkUpdateNotice.kind}`));
  const state = data.engine_state;
  update.body.append(
    valueRow('Current build', data.current_build),
    statusRow('Latest engine result', state ? `${state.stage} · ${state.status}` : 'no update recorded', frameworkUpdateKind(state)),
    valueRow('Latest message', state?.message ?? 'none'),
    valueRow('Update engine', data.engine_locked ? 'busy' : 'idle'),
  );

  const registry = section('Framework Registry');
  const frameworkCatalog = data.registry;
  const registryActionDisabled = !canWrite() || Boolean(data.active_job) || data.engine_locked;
  const refreshRegistryButton = actionButton('Refresh Registry', '', async () => {
    try {
      await apiData('/api/admin/package-registry/refresh', { method: 'POST', body: '{}' });
      frameworkUpdateNotice = { kind: 'good', text: 'Registry catalog refreshed.' };
    } catch (error) {
      frameworkUpdateNotice = { kind: 'bad', text: `Registry refresh: ${error.message ?? error}` };
    }
    await loadFrameworkUpdate();
  }, registryActionDisabled);
  if (!frameworkCatalog?.available) {
    const controls = document.createElement('div'); controls.className = 'button-row';
    controls.append(refreshRegistryButton);
    registry.body.append(text('p', 'No verified Framework version is available in the cached Registry catalog.', 'empty'), controls);
  } else {
    registry.body.append(
      valueRow('Source', frameworkCatalog.repository),
      valueRow('Current version', frameworkCatalog.current_version ?? data.current_build ?? 'unknown'),
      valueRow('Latest verified version', frameworkCatalog.latest_version),
      valueRow('Archive SHA-256', frameworkCatalog.file?.sha256 ?? 'n/a'),
    );
    const controls = document.createElement('div'); controls.className = 'button-row';
    if (frameworkCatalog.update_available) {
      controls.append(actionButton('Download and update', 'primary',
        () => runFrameworkRegistryUpdate(frameworkCatalog, data.current_build),
        !canWrite() || Boolean(data.active_job) || data.engine_locked));
    } else {
      controls.append(text('p', 'Framework is up to date.', 'status good'));
    }
    controls.append(refreshRegistryButton);
    registry.body.append(controls);
  }
  update.body.append(registry.card);

  const candidates = section('Update files');
  const uploadWrap = document.createElement('div'); uploadWrap.className = 'upload-row';
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.tar.gz,application/gzip';
  const progress = document.createElement('progress'); progress.hidden = true;
  const uploadButton = actionButton('Upload update file', 'primary', async () => {
    const file = input.files?.[0];
    if (!file) {
      frameworkUpdateNotice = { kind: 'bad', text: 'Choose one Framework .tar.gz update file first.' };
      return loadFrameworkUpdate();
    }
    uploadButton.disabled = true; progress.hidden = false;
    try {
      const result = await apiData('/api/admin/framework-update/uploads', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file,
      });
      frameworkUpdateNotice = { kind: 'good', text: `Uploaded ${result.upload.original_name}. Run the full check before the update can be installed.` };
    } catch (error) {
      frameworkUpdateNotice = { kind: 'bad', text: `Upload: ${error.message ?? error}` };
    }
    await loadFrameworkUpdate();
  }, !canWrite() || Boolean(data.active_job) || data.engine_locked);
  uploadWrap.append(input, uploadButton, progress); candidates.body.append(uploadWrap);
  if (!data.uploads?.length) candidates.body.append(text('p', 'No Framework update file has been uploaded.', 'empty'));
  else candidates.body.append(...data.uploads.map((upload) => frameworkUploadCard(upload, data.current_build,
    !canWrite() || Boolean(data.active_job) || data.engine_locked)));

  const recovery = section('Restore previous version');
  if (!data.last_good?.build) recovery.body.append(text('p', 'No verified previous-version backup is available; Restore is unavailable.', 'empty'));
  else {
    recovery.body.append(valueRow('Previous build', data.last_good.build), valueRow('Saved', data.last_good.created_at ? new Date(data.last_good.created_at).toLocaleString() : 'n/a'),
      valueRow('Health at backup', data.last_good.health ?? 'n/a'));
    recovery.body.append(actionButton('Restore previous version', 'danger-text', () => runFrameworkRollback(data.last_good, data.current_build),
      !canWrite() || Boolean(data.active_job) || data.engine_locked));
  }

  const jobs = section('Web operation progress');
  if (!data.jobs?.length) jobs.body.append(text('p', 'No Framework Web operation has been started.', 'empty'));
  else jobs.body.append(...data.jobs.slice(0, 8).map(frameworkJobCard));
  const history = section('Framework update history');
  if (!data.history?.length) history.body.append(text('p', 'The update engine has no recorded history.', 'empty'));
  else history.body.append(...data.history.map(frameworkHistoryCard));
  replacePage(update.card, candidates.card, recovery.card, jobs.card, history.card);
  if (data.active_job || data.engine_locked) frameworkUpdatePollTimer = setTimeout(() => loadFrameworkUpdate(), 1500);
}

async function loadFrameworkUpdate() {
  try {
    renderFrameworkUpdate(await apiData('/api/admin/framework-update'));
  } catch (error) {
    if (!frameworkUpdateReconnectSince) frameworkUpdateReconnectSince = Date.now();
    const seconds = Math.max(1, Math.floor((Date.now() - frameworkUpdateReconnectSince) / 1000));
    const reconnect = document.createElement('div'); reconnect.className = 'reconnect-state';
    reconnect.append(text('p', 'Reconnecting to Framework. The external update engine continues and its persistent state will reappear here.', 'alert warning'),
      text('small', `Waiting ${seconds}s…`), document.createElement('progress'));
    replacePage(reconnect);
    frameworkUpdatePollTimer = setTimeout(() => loadFrameworkUpdate(), 1500);
  }
}

async function startInstalledAction(item, action) {
  const rollback = action === 'rollback';
  const accepted = await confirmAction({
    title: rollback ? `Roll back ${item.name}` : `Uninstall ${item.name}`,
    label: rollback ? 'Roll back' : 'Uninstall',
    details: [
      ['Package ID', item.id],
      ['Current version', item.version],
      [rollback ? 'Restore version' : 'Installed code', rollback ? item.previous_version : 'will be removed'],
      ['Services stopped', item.services.length ? item.services.join(', ') : 'none declared'],
      ['Configuration / data', 'preserved'],
      ['Provider bindings / desired state', 'preserved'],
      ['Failure behavior', rollback ? 'Package Manager post-check reports failure' : 'operation result remains in job history'],
    ],
  });
  if (!accepted) return;
  try {
    const body = { confirm_package_id: item.id };
    if (rollback) body.confirm_previous_version = item.previous_version;
    const response = await api(`/api/admin/package-manager/packages/${encodeURIComponent(item.id)}/${action}`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? result.error);
    packageNotice = { kind: 'good', text: `Started ${jobLabel(result.job)}. Framework may restart; this page will reconnect to the persistent result.` };
  } catch (error) {
    packageNotice = { kind: 'bad', text: String(error?.message ?? error) };
  }
  await loadPackageManager();
}

async function installUpload(upload) {
  const identity = upload.identity;
  const snapshot = await (await api('/api/admin/package-manager')).json();
  const current = snapshot.packages?.find((p) => p.id === identity.id);
  const accepted = await confirmAction({
    title: `Install ${identity.name ?? identity.id}`,
    label: current ? 'Install update' : 'Install',
    details: [
      ['Package ID', identity.id],
      ['Current version', current?.version ?? 'not installed'],
      ['Package version', identity.version],
      ['Target', identity.target],
      ['File SHA-256', upload.sha256],
      ['Services stopped', identity.services?.length ? identity.services.join(', ') : 'none declared'],
      ['Configuration / data', 'preserved'],
      ['Failure behavior', current ? 'the previous version is restored automatically' : 'the incomplete install is removed'],
    ],
    acknowledgement: upload.registry_verified === true
      ? null
      : 'I understand this archive SHA-256 is not in the verified Registry list and I want to install it manually.',
  });
  if (!accepted) return;
  try {
    const response = await api(`/api/admin/package-manager/uploads/${upload.id}/install`, {
      method: 'POST',
      body: JSON.stringify({
        confirm_sha256: upload.sha256,
        ...(upload.registry_verified === true ? {} : { confirm_unverified: true }),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? result.error);
    packageNotice = { kind: 'good', text: `Started ${jobLabel(result.job)}. Framework may restart; this page will reconnect to the persistent result.` };
  } catch (error) {
    packageNotice = { kind: 'bad', text: String(error?.message ?? error) };
  }
  await loadPackageManager();
}

async function discardUpload(upload) {
  const accepted = await confirmAction({
    title: 'Discard uploaded package file',
    label: 'Discard',
    details: [
      ['File', upload.original_name],
      ['File SHA-256', upload.sha256],
      ['Installed Packages', 'unchanged'],
    ],
  });
  if (!accepted) return;
  const response = await api(`/api/admin/package-manager/uploads/${upload.id}`, { method: 'DELETE' });
  const result = await response.json();
  packageNotice = response.ok
    ? { kind: 'good', text: 'Uploaded package file discarded.' }
    : { kind: 'bad', text: result.detail ?? result.error };
  await loadPackageManager();
}

async function retryPreflight(upload) {
  try {
    const response = await api(`/api/admin/package-manager/uploads/${upload.id}/check`, {
      method: 'POST', body: '{}',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? result.error);
    packageNotice = { kind: 'good', text: `Started ${jobLabel(result.job)}.` };
  } catch (error) {
    packageNotice = { kind: 'bad', text: String(error?.message ?? error) };
  }
  await loadPackageManager();
}

function packageMatches(item) {
  const haystack = [item.name, item.admin_title, item.publisher, item.repository, item.id, item.description, ...(item.types ?? []), ...(item.official ?? [])]
    .join(' ').toLowerCase();
  return (!packageSearch || haystack.includes(packageSearch.toLowerCase()))
    && (packageFilter === 'all' || item.types?.includes(packageFilter));
}

const packageSettingAnchor = (id) => `package-setting-${String(id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

function packageAdminName(item) {
  const title = item.admin_title ?? item.name ?? item.id;
  return item.publisher ? `${title} [${item.publisher}]` : title;
}

function packageEnableToggle(item, { after = loadPackageSettings } = {}) {
  const label = document.createElement('label');
  label.className = 'enable-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = item.enabled === true;
  input.disabled = !canWrite();
  input.setAttribute('aria-label', `${input.checked ? 'Disable' : 'Enable'} ${packageAdminName(item)}`);
  const track = document.createElement('span');
  track.className = 'enable-toggle-track';
  const state = text('span', input.checked ? 'On' : 'Off', 'enable-toggle-state');
  const updateLabel = () => {
    state.textContent = input.checked ? 'On' : 'Off';
    input.setAttribute('aria-label', `${input.checked ? 'Disable' : 'Enable'} ${packageAdminName(item)}`);
  };
  input.addEventListener('change', async () => {
    const previous = !input.checked;
    input.disabled = true;
    const succeeded = await packageSettingAction(item, input.checked ? 'enable' : 'disable', after);
    if (!succeeded) input.checked = previous;
    input.disabled = false;
    updateLabel();
  });
  label.append(input, track, state);
  return label;
}

function githubRepositoryLink(item) {
  if (!item.repository) return null;
  let url;
  try { url = new URL(item.repository); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
  const link = document.createElement('a');
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = 'package-source-link';
  link.setAttribute('aria-label', `GitHub source for ${packageAdminName(item)}`);
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.add('github-mark');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.92 .58 .11 .79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.67 1.25 3.32 .96 .1-.74 .4-1.25 .73-1.54-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47 .11-3.06 0 0 .96-.31 3.15 1.18A10.9 10.9 0 0 1 12 8.58c.97 0 1.94.13 2.85 .38 2.18-1.49 3.14-1.18 3.14-1.18 .62 1.59 .23 2.77 .12 3.06 .73 .81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69 .41 .36 .78 1.08 .78 2.18 0 1.57-.01 2.83-.01 3.21 0 .31 .21 .67 .8 .56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35 .5 12 .5z');
  icon.append(path);
  link.append(icon, text('span', 'GitHub'));
  return link;
}

function packageOpenLink(href, { newTab = false } = {}) {
  const link = document.createElement('a');
  link.href = href;
  link.textContent = 'Open';
  link.className = 'button-link primary-link package-open-link';
  if (newTab) {
    link.target = '_blank';
    link.rel = 'noopener';
  }
  return link;
}

function packageSettingLink(item) {
  const link = document.createElement('a');
  link.href = `/admin/packages/settings#${packageSettingAnchor(item.id)}`;
  link.textContent = 'Setting';
  link.className = 'button-link package-setting-link';
  link.setAttribute('aria-label', `Settings for ${packageAdminName(item)}`);
  return link;
}

function renderPackageCard(item) {
  const card = document.createElement('article'); card.className = 'panel package-card';
  const head = document.createElement('div'); head.className = 'package-card-head';
  head.append(text('span', '▦', 'package-icon'));
  const title = document.createElement('div'); title.className = 'package-card-title';
  title.append(text('b', packageAdminName(item)), text('small', item.id));
  head.append(title, packageEnableToggle(item, { after: loadPackageManager }));
  card.append(head);
  card.append(text('p', item.description ?? 'No Package description was declared.', 'package-card-description'));
  const source = githubRepositoryLink(item);
  if (source) {
    const sourceRow = document.createElement('div'); sourceRow.className = 'package-card-source';
    sourceRow.append(source); card.append(sourceRow);
  }
  const tags = document.createElement('div'); tags.className = 'package-tags';
  tags.append(text('span', item.version, 'package-tag'), text('span', item.target ?? 'generic', 'package-tag'));
  for (const type of item.types ?? []) tags.append(text('span', type, 'package-tag'));
  card.append(tags);
  const meta = document.createElement('div'); meta.className = 'package-meta';
  meta.append(valueRow('Runtime', item.runtime ?? 'n/a'), valueRow('API ports', item.ports?.length ? item.ports.map((p) => `${p.id}:${p.port}`).join(', ') : 'none'));
  card.append(meta);
  const actions = document.createElement('div'); actions.className = 'button-row package-card-actions';
  if (item.webui) actions.append(packageOpenLink(item.webui, { newTab: true }));
  actions.append(packageSettingLink(item));
  if (item.previous_version) actions.append(actionButton('Rollback', '', () => startInstalledAction(item, 'rollback')));
  actions.append(actionButton('Uninstall', 'danger-text', () => startInstalledAction(item, 'uninstall')));
  card.append(actions);
  const details = document.createElement('details'); details.className = 'inline-details';
  details.append(Object.assign(document.createElement('summary'), { textContent: 'Version details' }),
    text('small', `SHA ${item.archive_sha256 ?? 'n/a'} · installed ${item.installed_at ?? 'n/a'}`));
  card.append(details);
  return card;
}

async function loadAdapters() {
  try {
    const data = await apiData('/api/admin/package-manager');
    const panel = section('Adapter catalog');
    panel.body.append(text('p', 'Adapters are the bridges between Packages, devices, engines, and external APIs. Their assigned ports and lifecycle remain owned by the Package Manager.', 'description'));
    const adapters = (data.packages ?? []).filter((item) => item.types?.includes('adapter'));
    if (!adapters.length) panel.body.append(text('p', 'No Adapter Packages are installed yet.', 'empty'));
    else {
      const grid = document.createElement('div'); grid.className = 'package-grid';
      grid.append(...adapters.map(renderPackageCard)); panel.body.append(grid);
    }
    replacePage(panel.card, renderJobs(data));
  } catch (error) {
    const panel = section('Adapter catalog');
    panel.body.append(text('p', `Could not load Adapters: ${error.message ?? error}`, 'alert error'));
    replacePage(panel.card);
  }
}

function renderInstalledPackages(data) {
  const wrap = document.createElement('div');
  if (data.broken?.length) wrap.append(text('div', `${data.broken.length} Installed Root record(s) need review. See Recent operations for the exact failure.`, 'alert error'));
  const packages = (data.packages ?? []).filter(packageMatches);
  if (!data.packages?.length) wrap.append(text('p', 'No Packages are installed yet. Install one from a file below.', 'empty'));
  else if (!packages.length) wrap.append(text('p', 'No Package matches the current search or filter.', 'empty'));
  else {
    const grid = document.createElement('div'); grid.className = 'package-grid';
    grid.append(...packages.map(renderPackageCard)); wrap.append(grid);
  }
  const candidates = data.uploads?.filter((u) => u.status !== 'installed') ?? [];
  if (candidates.length) {
    wrap.append(text('h3', 'Pending install'), text('p', 'Files waiting to be checked or installed appear here. A file not in the verified list needs an explicit safety acknowledgement.', 'description'));
    wrap.append(...candidates.map(preflightSummary));
  }
  return wrap;
}

function preflightSummary(upload) {
  const box = document.createElement('div');
  box.className = 'panel release-card';
  const id = upload.identity;
  box.append(
    text('b', id ? `${id.name ?? id.id} ${id.version}` : upload.original_name),
    text('code', upload.sha256),
    statusRow('Status', packageUploadStatus(upload),
      upload.status === 'preflight_passed' ? 'good' : upload.status === 'preflight_failed' ? 'bad' : 'neutral'),
  );
  if (id) {
    box.append(
      valueRow('Package ID', id.id),
      valueRow('Target', id.target),
      valueRow('Type', id.types?.join(', ') || 'n/a'),
    );
  }
  if (upload.origin) {
    box.append(valueRow('Registry source', `${upload.origin.repository} · ${upload.origin.version}`));
  }
  box.append(valueRow('Registry trust', upload.registry_verified === true ? 'Verified catalog hash' : 'Not in verified catalog'));
  if (upload.preflight) {
    const missing = (upload.preflight.external ?? []).filter((x) => x.ok === false && x.required);
    box.append(
      valueRow('Target verdict', upload.preflight.target?.verdict ?? 'n/a'),
      valueRow('Required dependencies', missing.length ? missing.map((x) => x.id).join(', ') : 'satisfied'),
    );
  }
  const actions = document.createElement('div');
  actions.className = 'button-row';
  if (upload.status === 'preflight_passed') {
    actions.append(actionButton('Install', 'primary', () => installUpload(upload)));
  } else if (upload.status === 'preflight_failed' || upload.status === 'uploaded') {
    actions.append(actionButton('Check again', '', () => retryPreflight(upload)));
  }
  if (!['installed', 'install_failed'].includes(upload.status)) {
    actions.append(actionButton('Discard', 'danger-text', () => discardUpload(upload)));
  }
  box.append(actions);
  return box;
}

function packageUploadStatus(upload) {
  return ({
    uploaded: 'Checking',
    preflight_passed: 'Ready to install',
    preflight_failed: 'Check failed',
    installed: 'Installed',
    install_failed: 'Install failed',
  })[upload.status] ?? String(upload.status ?? 'Unknown').replaceAll('_', ' ');
}

function registryDisplayName(item) {
  const name = item.display_name ?? item.repository;
  return item.official?.length ? `${name} [Official]` : name;
}

function renderRegistryDetails(container, details) {
  container.replaceChildren();
  const rows = [];
  const detailKey = (key) => String(key).replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  const detailValue = (value) => {
    if (Array.isArray(value)) return value.map(detailValue).join(', ');
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([key, entry]) => `${detailKey(key)}: ${detailValue(entry)}`).join(' · ');
    }
    return String(value);
  };
  const appendSection = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    rows.push(valueRow(label, detailValue(value)));
  };
  appendSection('Dependencies', details.dependencies);
  appendSection('Permissions', details.security?.permissions ?? details.permissions);
  appendSection('Network', details.security?.network);
  appendSection('Data access', details.security?.data_access);
  appendSection('Capabilities', details.capabilities);
  appendSection('Ports', details.ports);
  appendSection('License', details.license);
  appendSection('AI disclosure', details.ai_disclosure);
  if (details.official?.length) appendSection('Official maintainers', details.official);
  if (!rows.length) rows.push(text('p', 'No additional public details were declared.', 'empty'));
  container.append(...rows);
}

function renderRegistry(data) {
  const wrap = document.createElement('div');
  const registry = data.registry ?? { status: 'not_fetched', packages: [] };
  wrap.append(text('p', 'These verified Packages are available to install. Open Details first, then download and check the package before installing it.', 'description'));
  const controls = document.createElement('div'); controls.className = 'button-row';
  controls.append(actionButton('Refresh list', 'primary', async () => {
    try {
      await apiData('/api/admin/package-registry/refresh', { method: 'POST', body: '{}' });
      packageNotice = { kind: 'good', text: 'Available package list refreshed.' };
    } catch (error) {
      packageNotice = { kind: 'bad', text: `Registry refresh: ${error.message ?? error}` };
    }
    await loadPackageManager();
  }, !canWrite() || Boolean(data.active_job)));
  wrap.append(controls);
  if (registry.status !== 'ready' && registry.status !== 'stale') {
    wrap.append(text('p', 'The catalog has not been loaded on this device yet.', 'empty'));
    return wrap;
  }
  if (registry.status === 'stale') {
    wrap.append(text('p', `Showing the last cached catalog. Refresh failed: ${registry.error?.code ?? 'registry unavailable'}.`, 'alert warning'));
  }
  if (registry.fetched_at) {
    wrap.append(text('small', `Updated ${new Date(registry.updated_at ?? registry.generated_at ?? registry.fetched_at).toLocaleString()}`, 'meta'));
  }
  if (!registry.packages?.length) {
    wrap.append(text('p', 'The Registry returned no Packages.', 'empty'));
    return wrap;
  }
  const grid = document.createElement('div'); grid.className = 'package-grid registry-grid';
  for (const item of registry.packages) {
    const card = document.createElement('article'); card.className = 'panel package-card registry-card';
    const version = item.versions?.find((entry) => entry.version === (item.latest_verified_version ?? item.latest_version)) ?? item.versions?.[0];
    const file = version?.files?.find((entry) => entry.kind === 'source_tar' && entry.name.endsWith('.tar.gz'));
    card.append(text('b', registryDisplayName(item)), text('small', item.repository, 'meta'));
    if (item.description) card.append(text('p', item.description, 'package-card-description'));
    card.append(valueRow('Latest verified', version?.version ?? item.latest_verified_version ?? 'n/a'),
      valueRow('Published', item.latest_verified_published_at ?? version?.published_at ?? 'n/a'));
    if (file) {
      card.append(valueRow('Source archive', `${file.name} · ${formatBytes(file.size)}`));
      const detailBox = document.createElement('div'); detailBox.className = 'registry-details'; detailBox.hidden = true;
      const selection = { source: item.source, repository: item.repository, version: version.version, kind: file.kind, file: file.name };
      let publicDetailsLoaded = false;
      const download = actionButton('Download', 'primary', async () => {
        try {
          const result = await apiData('/api/admin/package-registry/download', {
            method: 'POST',
            body: JSON.stringify(selection),
          });
          packageTab = 'installed';
          packageNotice = { kind: 'good', text: `Downloaded ${file.name}; package check started. Review it under Installed.` };
          if (result.upload?.origin) {
            const pathLabel = result.upload.origin.path === 'github_direct' ? 'GitHub direct'
              : result.upload.origin.path === 'termux_os_registry' ? 'Termux-OS Registry' : 'verified source';
            packageNotice.text += ` Source path: ${pathLabel}.`;
          }
        } catch (error) {
          if (error?.data?.manual?.release_url) {
            packageTab = 'upload';
            await showManualDownloadDialog({
              title: 'Download Package manually',
              manual: error.data.manual,
              nextStep: 'After transferring the archive to this device, use Install from file to upload and install it after the normal Package checks.',
            });
          }
          packageNotice = { kind: 'bad', text: `Registry download: ${error.message ?? error}` };
        }
        await loadPackageManager();
      }, !canWrite() || Boolean(data.active_job) || !publicDetailsLoaded);
      const detailsButton = actionButton('Details', '', async () => {
        detailsButton.disabled = true;
        try {
          const result = await apiData('/api/admin/package-registry/details', { method: 'POST', body: JSON.stringify(selection) });
          renderRegistryDetails(detailBox, { ...result.details, official: item.official });
          detailBox.hidden = false;
          publicDetailsLoaded = true;
          download.disabled = !canWrite() || Boolean(data.active_job);
          detailsButton.textContent = 'Refresh';
        } catch (error) {
          packageNotice = { kind: 'bad', text: `Package details: ${error.message ?? error}` };
        }
        detailsButton.disabled = false;
      }, !canWrite() || Boolean(data.active_job));
      const actions = document.createElement('div'); actions.className = 'button-row';
      actions.append(detailsButton, download);
      card.append(detailBox, actions);
    } else {
      card.append(text('p', 'No pinned source archive is available for this version.', 'empty'));
    }
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

function renderUpload(data) {
  const wrap = document.createElement('div');
  wrap.append(text('p',
    'Choose a package file. The Framework checks its identity and requirements before Install is enabled.',
    'description'));
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.tar.gz,application/gzip'; input.id = 'package-file';
  const progress = document.createElement('progress');
  progress.hidden = true;
  const upload = actionButton('Add and check', 'primary', async () => {
    const file = input.files?.[0];
    if (!file) {
      packageNotice = { kind: 'bad', text: 'Choose a .tar.gz package file first.' };
      return loadPackageManager();
    }
    upload.disabled = true; progress.hidden = false;
    try {
      const response = await api('/api/admin/package-manager/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail ?? result.error);
      packageTab = 'installed';
      packageNotice = { kind: 'good', text: `Added ${file.name}; package check started.` };
    } catch (error) {
      packageNotice = { kind: 'bad', text: String(error?.message ?? error) };
    }
    await loadPackageManager();
  });
  const controls = document.createElement('div');
  controls.className = 'upload-row';
  controls.append(input, upload, progress);
  wrap.append(controls);
  if (data.uploads?.length) {
    wrap.append(text('h3', 'Recent uploads'), ...data.uploads.slice(0, 5).map(preflightSummary));
  }
  return wrap;
}

function renderJobs(data) {
  const panel = section('Recent operations');
  const fold = document.createElement('details'); fold.className = 'collapsible-panel';
  if (data.active_job) fold.open = true;
  const summary = document.createElement('summary'); summary.textContent = data.jobs?.length ? `Show ${Math.min(data.jobs.length, 8)} recent operations` : 'No Package lifecycle jobs yet';
  fold.append(summary);
  const body = document.createElement('div'); body.className = 'collapsible-body';
  if (!data.jobs?.length) body.append(text('p', 'No Package lifecycle jobs yet.', 'empty'));
  for (const job of data.jobs?.slice(0, 8) ?? []) {
    const details = document.createElement('details');
    details.className = 'job-row';
    if (data.active_job?.id === job.id) details.open = true;
    const summary = document.createElement('summary');
    summary.append(
      text('b', `${job.action} · ${job.target.package_id ?? job.target.upload_id}`),
      text('span', `${job.stage} · ${job.status}`, `status ${job.status === 'success' ? 'good' : job.status === 'failed' ? 'bad' : 'neutral'}`),
    );
    details.append(summary);
    if (['queued', 'running'].includes(job.status)) details.append(document.createElement('progress'));
    if (job.output) details.append(text('pre', job.output));
    if (job.error) details.append(text('p', job.error, 'alert error'));
    body.append(details);
  }
  fold.append(body); panel.body.append(fold);
  return panel.card;
}

function renderPackageManager(data) {
  if (packagePollTimer) { clearTimeout(packagePollTimer); packagePollTimer = null; }
  packageReconnectSince = 0;
  const panel = section('Package Manager');
  panel.body.append(text('p', 'Installed shows what is on this device. Available shows verified Packages you can install. You can also install a package from a file.', 'description'));
  if (packageNotice) panel.body.append(text('p', packageNotice.text, `alert ${packageNotice.kind}`));
  const toolbar = document.createElement('div'); toolbar.className = 'package-toolbar';
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search Packages'; search.value = packageSearch; search.setAttribute('aria-label', 'Search Packages');
  search.addEventListener('input', () => { packageSearch = search.value; renderPackageManager(data); });
  const filters = document.createElement('div'); filters.className = 'package-filters';
  const types = ['all', ...new Set((data.packages ?? []).flatMap((item) => item.types ?? []))];
  for (const type of types) {
    const button = actionButton(type === 'all' ? 'All' : type, packageFilter === type ? 'active' : '', () => { packageFilter = type; renderPackageManager(data); });
    filters.append(button);
  }
  toolbar.append(search, filters);
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  const content = document.createElement('div');
  const views = {
    installed: () => renderInstalledPackages(data),
    registry: () => renderRegistry(data),
    upload: () => renderUpload(data),
  };
  for (const [id, label] of [['installed', `Installed (${data.packages?.length ?? 0})`],
    ['registry', `Available (${data.registry?.packages?.length ?? 0})`],
    ['upload', 'Install from file']]) {
    const button = actionButton(label, packageTab === id ? 'active' : '', () => {
      packageTab = id;
      renderPackageManager(data);
    });
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(packageTab === id));
    tabs.append(button);
  }
  if (!views[packageTab]) packageTab = 'installed';
  content.append(views[packageTab]());
  panel.body.append(toolbar, tabs, content);
  replacePage(panel.card, renderJobs(data));
  if (data.active_job) packagePollTimer = setTimeout(() => loadPackageManager(), 1500);
}

async function loadPackageManager() {
  try {
    const response = await api('/api/admin/package-manager');
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail ?? data.error);
    // Package install/rollback/uninstall 会改变 menu 的 Package-owned 节点；不要求用户刷新或重新登录。
    // 菜单刷新失败不遮蔽真实 Package snapshot，下一次正常轮询会再试。
    try { await refreshAdminNavigation(); } catch { /* Package manager remains usable during a restart window. */ }
    renderPackageManager(data);
  } catch (error) {
    // install/rollback/uninstall 会短暂重启 Framework；继续探测，私有持久 Browser Session 会在
    // 进程重启后恢复。只有密码轮换/过期/明确 Logout 才会由 session.js 跳回 Login。
    if (!packageReconnectSince) packageReconnectSince = Date.now();
    const seconds = Math.max(1, Math.floor((Date.now() - packageReconnectSince) / 1000));
    const reconnect = document.createElement('div');
    reconnect.className = 'reconnect-state';
    reconnect.append(
      text('p', 'Reconnecting to Framework. The Package job continues and its persistent result will reappear here.', 'alert warning'),
      text('small', `Waiting ${seconds}s…`),
      document.createElement('progress'),
    );
    replacePage(reconnect);
    packagePollTimer = setTimeout(() => loadPackageManager(), 1500);
  }
}

function packageSettingStatus(item) {
  if (!item.enabled) return 'disabled';
  if (item.loader_status === 'loaded') return 'enabled';
  return item.loader_status ?? 'attention';
}

async function packageSettingAction(item, action, refresh = loadPackageSettings) {
  const labels = { restart: 'Restart', disable: 'Disable', enable: 'Enable' };
  const details = [
    ['Package', packageAdminName(item)],
    ['Version', item.version],
  ];
  if (action === 'restart') {
    details.push(
      ['Effect', 'Closes active Package clients, stops its runtime, kills its owned session if applicable, then reloads the current version.'],
      ['Persistent data', 'Package configuration and data are preserved.'],
    );
  } else if (action === 'disable') {
    details.push(
      ['Effect', 'Disables the Package, removes its active routes and menu entries, and kills its owned runtime session.'],
      ['Persistent data', 'Package configuration and data are preserved.'],
    );
  } else {
    details.push(
      ['Effect', 'Loads this Package and starts its App runtime. Termux Terminal creates a fresh termux-os tmux session.'],
      ['Persistent data', 'Package configuration and data are preserved.'],
    );
  }
  const accepted = await confirmAction({ title: `${labels[action]} ${packageAdminName(item)}`, label: labels[action], details });
  if (!accepted) return;
  let succeeded = false;
  try {
    const result = await apiData(`/api/admin/package-settings/${encodeURIComponent(item.id)}/${action}`, {
      method: 'POST', body: JSON.stringify({ confirm_package_id: item.id }),
    });
    packageSettingNotice = {
      kind: 'good',
      text: action === 'restart'
        ? `${packageAdminName(item)} restarted. Active sessions were disconnected; the persistent Package state remains.`
        : `${packageAdminName(item)} ${action}d.`,
    };
    if (result.message) packageSettingNotice.text = result.message;
    try { await refreshAdminNavigation(); } catch { /* The Package Setting page remains usable. */ }
    succeeded = true;
  } catch (error) {
    packageSettingNotice = { kind: 'bad', text: `${labels[action]}: ${error.message ?? error}` };
  }
  await refresh();
  return succeeded;
}

function packagePortEditor(item, policy) {
  const box = document.createElement('div');
  box.className = 'package-port-settings';
  const draft = (item.ports ?? []).map((port) => ({ ...port }));
  if (!draft.length) {
    box.append(text('p', 'This Package has no declared HTTP port.', 'empty'));
    return { box, draft, save: null };
  }
  for (const port of draft) {
    const row = document.createElement('div'); row.className = 'package-port-setting';
    const description = document.createElement('div'); description.className = 'package-port-label';
    description.append(text('b', port.id), text('small', `${String(port.protocol ?? 'http').toUpperCase()} · ${port.health ?? 'no health path'}`));
    const controls = document.createElement('div'); controls.className = 'package-port-controls';
    const number = document.createElement('input');
    number.type = 'number'; number.inputMode = 'numeric'; number.min = String(policy.range.start); number.max = String(policy.range.end);
    number.value = String(port.port); number.setAttribute('aria-label', `${port.id} port`);
    number.addEventListener('input', () => { port.port = Number(number.value); });
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'visibility-toggle';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = port.visibility === 'lan';
    const toggleText = text('span', toggle.checked ? 'LAN' : 'Device only');
    toggle.setAttribute('aria-label', `${port.id} visibility`);
    toggle.addEventListener('change', () => {
      port.visibility = toggle.checked ? 'lan' : 'loopback';
      toggleText.textContent = toggle.checked ? 'LAN' : 'Device only';
      if (toggle.checked) {
        box.classList.add('lan-warning');
        box.dataset.lanAcknowledgement = 'required';
      } else if (!draft.some((item) => item.visibility === 'lan')) {
        box.classList.remove('lan-warning');
        delete box.dataset.lanAcknowledgement;
      }
    });
    toggleLabel.append(toggle, toggleText);
    controls.append(number, toggleLabel);
    row.append(description, controls); box.append(row);
  }
  const save = actionButton('Save port settings', 'primary', async () => {
    if (draft.some((port) => port.visibility === 'lan')) {
      const accepted = await confirmAction({
        title: 'Expose Package API on the LAN',
        label: 'Enable LAN access',
        details: [
          ['Effect', 'The Package port will bind to the device network instead of loopback after restart.'],
          ['Security', 'Any device able to reach this network may probe the Package API. Use only a trusted network.'],
          ['Terminal warning', 'A Package such as Termux Terminal may expose an interactive shell and persistent tmux session.'],
          ['Reversal', 'Return the port to Device only and restart the Package to close the LAN listener.'],
        ],
      });
      if (!accepted) return;
    }
    try {
      const result = await apiData(`/api/admin/package-settings/${encodeURIComponent(item.id)}`, {
        method: 'POST', body: JSON.stringify({ confirm_package_id: item.id, ports: draft.map((port) => ({
          id: port.id, port: port.port, visibility: port.visibility,
        })) }),
      });
      packageSettingNotice = { kind: 'good', text: result.message ?? 'Package port settings saved.' };
    } catch (error) {
      packageSettingNotice = { kind: 'bad', text: `Save port settings: ${error.message ?? error}` };
    }
    await loadPackageSettings();
  }, !canWrite());
  box.append(save);
  return { box, draft, save };
}

function renderPackageSettingCard(item, policy) {
  const card = document.createElement('article'); card.className = 'panel package-setting-card';
  card.id = packageSettingAnchor(item.id);
  card.dataset.packageId = item.id;
  const head = document.createElement('div'); head.className = 'package-setting-head';
  const title = document.createElement('div'); title.className = 'package-card-title';
  title.append(text('b', packageAdminName(item)), text('small', item.id));
  head.append(title, packageEnableToggle(item));
  card.append(head);
  card.append(text('p', item.description ?? 'No Package description was declared.', 'package-card-description'));
  const source = githubRepositoryLink(item);
  if (source) {
    const sourceRow = document.createElement('div'); sourceRow.className = 'package-card-source';
    sourceRow.append(source); card.append(sourceRow);
  }
  card.append(valueRow('Version', item.version), valueRow('Services', item.services?.join(', ') || 'none'));
  if (item.loader_status === 'failed' || item.loader_status === 'incompatible') {
    card.append(text('p', item.error ?? `Package status: ${item.loader_status}`, 'alert error'));
  }
  const editor = packagePortEditor(item, policy);
  card.append(editor.box);
  const actions = document.createElement('div'); actions.className = 'button-row package-card-actions package-setting-actions';
  if (item.webui) actions.append(packageOpenLink(item.webui, { newTab: true }));
  actions.append(actionButton('Restart', '', () => packageSettingAction(item, 'restart'), !canWrite() || !item.enabled || item.loader_status !== 'loaded'));
  if (item.enabled) actions.append(actionButton('Disable', 'danger-text', () => packageSettingAction(item, 'disable'), !canWrite()));
  else actions.append(actionButton('Enable', 'primary', () => packageSettingAction(item, 'enable'), !canWrite()));
  card.append(actions);
  return card;
}

function renderPackageSettings(data) {
  const panel = section('Package Setting');
  panel.body.append(text('p', 'Control each installed Package as one unit. Port changes are saved to the private registry and take effect after Restart; switching to LAN makes a compliant Package bind its API on the device network.', 'description'));
  if (packageSettingNotice) panel.body.append(text('p', packageSettingNotice.text, `alert ${packageSettingNotice.kind}`));
  panel.body.append(valueRow('Package port range', `${data.policy.range.start}–${data.policy.range.end}`),
    valueRow('Core-reserved ports', data.policy.reserved.join(', ')),
    text('p', 'Device only uses loopback. LAN exposes the Package API on 0.0.0.0. Restart disconnects active Package sessions; the Package’s persistent configuration and data are kept.', 'muted'));
  if (!data.packages?.length) panel.body.append(text('p', 'No installed Packages are available for configuration.', 'empty'));
  else {
    const grid = document.createElement('div'); grid.className = 'package-setting-grid';
    grid.append(...data.packages.map((item) => renderPackageSettingCard(item, data.policy)));
    panel.body.append(grid);
  }
  replacePage(panel.card);
  const anchor = location.hash.slice(1);
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
}

async function loadPackageSettings() {
  try {
    const data = await apiData('/api/admin/package-settings');
    renderPackageSettings(data);
  } catch (error) {
    const panel = section('Package Setting');
    panel.body.append(text('p', `Could not load Package Setting: ${error.message ?? error}`, 'alert error'));
    replacePage(panel.card);
  }
}
