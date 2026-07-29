/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: Mobile Package Manager cards, pre-download details, a Framework version list whose rows
 *           update / reinstall / downgrade, and explicit safety-confirmed install actions.
 * [POS]: web/admin/admin-controls.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

// 引擎与作业状态是 API 值，不是给人读的词。显示时映射一次；映射不到就原样显示，
// 免得出现新状态时界面反而说不出它是什么。
const STATE_WORDS = {
  success: '成功', failed: '失败', failed_rolled_back: '失败并已回滚', queued: '排队中',
  running: '执行中', complete: '完成', preflight: '预检', 'preflight failed': '预检失败',
  preflight_failed: '预检失败', preflight_passed: '预检通过', rollback: '回滚', interrupted: '中断',
  install: '安装', check: '检查', uninstall: '卸载', update: '更新', uploaded: '已上传',
  registry_upgrade: '从 Registry 更新', rollback_job: '回滚', preflight_update: '预检',
  applied: '已安装', installed: '已安装', backup_skipped: '跳过备份',
};
const stateWord = (value) => STATE_WORDS[String(value ?? '').trim()] ?? value ?? '未知';

const frameworkUpdateKind = (state) => {
  if (state?.status === 'success') return 'good';
  if (['failed', 'failed_rolled_back'].includes(state?.status)) return 'bad';
  return 'neutral';
};

function frameworkJobCard(job) {
  const details = document.createElement('details'); details.className = 'job-row';
  if (['queued', 'running'].includes(job.status)) details.open = true;
  const summary = document.createElement('summary');
  summary.append(text('b', `${stateWord(job.action)} · ${job.target?.upload_id ?? 'last-good'}`),
    text('span', `${stateWord(job.stage)} · ${stateWord(job.status)}`, `status ${frameworkUpdateKind(job)}`));
  details.append(summary);
  if (['queued', 'running'].includes(job.status)) details.append(document.createElement('progress'));
  if (job.output) details.append(text('pre', job.output));
  if (job.error) details.append(text('p', job.error, 'alert error'));
  return details;
}
function frameworkHistoryCard(entry) {
  const row = document.createElement('details'); row.className = 'job-row';
  const summary = document.createElement('summary');
  summary.append(text('b', `${entry.previous_build ?? '未知'} → ${entry.candidate_build ?? '未知'}`),
    text('span', `${stateWord(entry.result)}${entry.rollback ? ' · 已回滚' : ''}`, `status ${entry.result === 'success' ? 'good' : 'bad'}`));
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
    const intro = text('p', 'GitHub 直连和 Termux-OS Registry 都下载失败。可以复制 GitHub Release 页面地址，自己下载已验证的 .tar.gz，再回到这里从文件安装。', 'description');
    const label = document.createElement('label'); label.textContent = 'GitHub Release 页面';
    const row = document.createElement('div'); row.className = 'manual-download-url-row';
    const input = document.createElement('input'); input.type = 'text'; input.value = manual.release_url; input.readOnly = true; input.select();
    const copy = actionButton('复制地址', '', async () => {
      const copied = await copyText(manual.release_url);
      copy.textContent = copied ? 'Copied' : 'Select and copy';
      if (!copied) { input.focus(); input.select(); }
    });
    row.append(input, copy);
    const link = linkButton('打开 Release 页面', manual.release_url, '', { newTab: true });
    form.append(heading, intro, label, row, link, text('p', nextStep, 'alert warning'));
    const actions = document.createElement('div'); actions.className = 'button-row';
    actions.append(actionButton('关闭', '', () => dialog.close('close')));
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
    title: '安装 Framework 更新',
    label: 'Update Framework',
    details: [
      ['当前构建', currentBuild ?? '未知'],
      ['更新文件', upload.original_name],
      ['目标构建', upload.preflight?.candidate_build ?? 'validated by formal check'],
      ['File SHA-256', upload.sha256],
      ['会保留', 'Installed Packages, persistent config/data and assets'],
      ['成功判据', 'Browser Login, admin menu, integrity, Package inventory and boundary comparison'],
      ['失败时的行为', 'the existing engine automatically restores the previous version and records the evidence'],
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
    title: '恢复上一个 Framework 版本',
    label: '恢复',
    details: [
      ['当前构建', currentBuild ?? '未知'],
      ['恢复上一个版本', lastGood.build],
      ['会保留', 'Installed Packages, persistent config/data and assets'],
      ['成功判据', 'the existing engine repeats core and boundary checks'],
      ['失败时的行为', 'the existing engine restores the operation-start runtime when possible'],
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

// 一个版本能做的三件事，取决于它相对当前版本的位置。措辞必须说清后果——
// 「降级」不是「更新」的反向操作，旧版可能读不懂当前配置。
const FRAMEWORK_VERSION_ACTIONS = {
  newer: { label: '更新', variant: 'primary', title: '更新 Framework' },
  current: { label: '重新安装', variant: '', title: '重新安装当前版本' },
  older: { label: '降级', variant: 'danger', title: '降级 Framework' },
  unknown: { label: '安装', variant: '', title: '安装此版本' },
};

async function runFrameworkRegistryUpdate(registry, currentBuild, entry = null) {
  const target = entry ?? { version: registry.latest_version, relation: 'newer',
    size: registry.file?.size ?? null, sha256: registry.file?.sha256 ?? null,
    selection: registry.selection };
  const action = FRAMEWORK_VERSION_ACTIONS[target.relation] ?? FRAMEWORK_VERSION_ACTIONS.unknown;
  const details = [
    ['当前版本', currentBuild ?? registry.current_version ?? '未知'],
    [target.relation === 'older' ? '降级到' : target.relation === 'current' ? '重新安装' : 'New version', target.version],
    ['Source', `${registry.repository} · ${target.selection?.upstream_ref ?? 'verified Registry source'}`],
    ['Size', formatBytes(target.size)],
    ['File SHA-256', target.sha256 ?? 'not available'],
    ['更新路径', 'download through Package Registry, then independent installer'],
    ['会保留', 'Framework configuration, credentials, Packages, models and caches'],
    ['失败时的行为', 'installer restores the previous runtime before reporting failure'],
  ];
  if (target.relation === 'older') {
    details.push(['⚠ 降级风险', '旧版本可能读不懂当前版本写下的配置；如果起不来，用下方 Restore previous version 退回。']);
  }
  const accepted = await confirmAction({ title: action.title, label: action.label, details });
  if (!accepted) return;
  try {
    const result = await apiData('/api/admin/framework-update/registry', {
      method: 'POST', body: JSON.stringify({ version: target.version, confirm_version: target.version }),
    });
    frameworkUpdateNotice = { kind: 'good', text: `Downloaded ${target.version}; ${jobLabel(result.job)} is installing it.` };
  } catch (error) {
    if (error?.data?.manual?.release_url) {
      await showManualDownloadDialog({
        title: '手动下载 Framework 更新',
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
    valueRow('大小', formatBytes(upload.size)),
    statusRow('检查', stateWord(upload.status.replaceAll('_', ' ')),
      upload.status === 'preflight_passed' || upload.status === 'applied' ? 'good'
        : upload.status === 'preflight_failed' ? 'bad' : 'neutral'));
  if (upload.preflight?.candidate_build) card.append(valueRow('目标构建', upload.preflight.candidate_build));
  const controls = document.createElement('div'); controls.className = 'button-row';
  if (['uploaded', 'preflight_failed'].includes(upload.status)) {
    controls.append(actionButton('运行检查', '', () => runFrameworkPreflight(upload), disabled));
  }
  if (upload.status === 'preflight_passed') {
    controls.append(actionButton('更新 Framework', 'primary', () => runFrameworkUpdate(upload, currentBuild), disabled));
  }
  if (upload.preflight?.output) {
    const output = document.createElement('details');
    output.append(Object.assign(document.createElement('summary'), { textContent: '检查详情' }), text('pre', upload.preflight.output));
    card.append(output);
  }
  card.append(controls);
  return card;
}

function renderFrameworkUpdate(data) {
  if (frameworkUpdatePollTimer) { clearTimeout(frameworkUpdatePollTimer); frameworkUpdatePollTimer = null; }
  frameworkUpdateReconnectSince = 0;
  const update = section('Framework');
  if (frameworkUpdateNotice) update.body.append(text('p', frameworkUpdateNotice.text, `alert ${frameworkUpdateNotice.kind}`));
  const state = data.engine_state;
  update.body.append(valueRow('当前版本', data.current_build));
  // 引擎状态只在它不是「闲着而且上一次成功」时才值得占位置：
  // 平时把它常驻在首屏，等于让每次打开这一页都先读一遍与自己无关的内部状态。
  if (data.engine_locked || (state && state.status !== 'success')) {
    update.body.append(
      statusRow('更新引擎', data.engine_locked ? '正在执行' : `${stateWord(state.stage)} · ${stateWord(state.status)}`,
        frameworkUpdateKind(state)),
      valueRow('说明', state?.message ?? '无'),
    );
  }

  const registry = section('Framework 版本');
  const frameworkCatalog = data.registry;
  const registryActionDisabled = !canWrite() || Boolean(data.active_job) || data.engine_locked;
  const refreshRegistryButton = actionButton('更新列表', '', async () => {
    try {
      await apiData('/api/admin/package-registry/refresh', { method: 'POST', body: '{}' });
      frameworkUpdateNotice = { kind: 'good', text: '目录已更新。' };
    } catch (error) {
      frameworkUpdateNotice = { kind: 'bad', text: `Registry refresh: ${error.message ?? error}` };
    }
    await loadFrameworkUpdate();
  }, registryActionDisabled);
  if (!frameworkCatalog?.available) {
    const controls = document.createElement('div'); controls.className = 'button-row';
    controls.append(refreshRegistryButton);
    registry.body.append(text('p', '缓存的目录里没有已验证的 Framework 版本。', 'empty'), controls);
  } else {
    registry.body.append(
      valueRow('来源', frameworkCatalog.repository),
      valueRow('当前版本', frameworkCatalog.current_version ?? data.current_build ?? 'unknown'),
    );

    // 掛載中的 Dev Runtime 會擋下更新。把「停止全部挂载」直接放在這裡——
    // 讓使用者為了更新而去別的頁面翻找（或更糟，去開 Termux）是把流程做了一半。
    const controls = document.createElement('div'); controls.className = 'button-row';
    if (data.dev_mounts?.length) {
      controls.append(actionButton(`停止全部挂载（${data.dev_mounts.length}）`, '', async () => {
        for (const mount of data.dev_mounts) {
          try {
            await apiData(`/api/dev/packages/${encodeURIComponent(mount.instance_id ?? mount.package_id)}/stop`,
              { method: 'POST', body: '{}' });
          } catch (error) {
            frameworkUpdateNotice = { kind: 'bad', text: `停止 ${mount.package_id} 失败：${error.message ?? error}` };
          }
        }
        frameworkUpdateNotice ??= { kind: 'good', text: '已停止全部挂载；Workspace 的项目都保留着，现在可以更新。' };
        await loadFrameworkUpdate();
      }, !canWrite()));
    }
    controls.append(refreshRegistryButton);
    registry.body.append(controls);

    // 列出全部已驗證版本，而不只是 latest。「已經是最新」不代表這頁沒事可做：
    // 檔案壞了要能重裝當前版本，新版有問題要能挑一個舊版裝回去。
    const busy = !canWrite() || Boolean(data.active_job) || data.engine_locked;
    const versions = frameworkCatalog.versions ?? [];
    const versionRow = (entry) => {
      const row = document.createElement('div'); row.className = 'version-row';
      const label = document.createElement('div'); label.className = 'version-label';
      label.append(text('span', entry.version, 'version-name'));
      if (entry.relation === 'current') label.append(text('span', '当前', 'status good'));
      const meta = [];
      if (entry.published_at) meta.push(String(entry.published_at).slice(0, 10));
      if (entry.size) meta.push(formatBytes(entry.size));
      if (meta.length) label.append(text('span', meta.join(' · '), 'version-meta'));
      const action = FRAMEWORK_VERSION_ACTIONS[entry.relation] ?? FRAMEWORK_VERSION_ACTIONS.unknown;
      row.append(label, actionButton(action.label, action.variant,
        () => runFrameworkRegistryUpdate(frameworkCatalog, data.current_build, entry), busy));
      return row;
    };
    // 平时只需要看到「能升到哪」和「当前这版能不能重装」。把每一个历史版本都摆出来，
    // 等于要用户在一串自己从没用过的版本号里找那一个有意义的。真要退回去，
    // 下面的「恢复上一个版本」才是有备份保证的路径；这里的旧版本只是最后手段。
    const primary = versions.filter((entry) => entry.relation === 'newer' || entry.relation === 'current');
    const older = versions.filter((entry) => entry.relation === 'older' || entry.relation === 'unknown');
    if (!versions.length) {
      registry.body.append(text('p', '缓存的目录里没有这个项目的已验证安装包。', 'empty'));
    } else {
      const list = document.createElement('div'); list.className = 'version-list';
      for (const entry of primary) list.append(versionRow(entry));
      // 没有可升级项时要说出来。留一片空白，使用者读到的是「加载失败」而不是「已经最新」。
      if (!primary.length) {
        registry.body.append(text('p',
          `目录里没有比 ${frameworkCatalog.current_version ?? data.current_build} 更新的版本，也没有它自己的安装包。`,
          'empty'));
      }
      registry.body.append(list);
      if (older.length) {
        const more = document.createElement('details');
        more.append(text('summary', `更早的版本（${older.length}）`));
        const oldList = document.createElement('div'); oldList.className = 'version-list';
        oldList.append(text('p', '装回旧版本前请先确认：旧版本可能读不懂当前版本写下的配置。', 'description'));
        for (const entry of older) oldList.append(versionRow(entry));
        more.append(oldList);
        registry.body.append(more);
      }
    }
  }
  update.body.append(registry.card);

  // 离线安装仍然需要，但它不该常驻首屏：绝大多数更新走 Registry，
  // 而「上传过哪些文件」是过程信息，不是这一页要回答的问题。
  const candidates = section('从文件安装');
  candidates.body.append(text('p', '没有网络时，可以在这里上传 Framework 的 .tar.gz 安装包。', 'description'));
  const uploadWrap = document.createElement('div'); uploadWrap.className = 'upload-row';
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.tar.gz,application/gzip';
  const progress = document.createElement('progress'); progress.hidden = true;
  const uploadButton = actionButton('上传安装包', '', async () => {
    const file = input.files?.[0];
    if (!file) {
      frameworkUpdateNotice = { kind: 'bad', text: '请先选择一个 Framework 的 .tar.gz 安装包。' };
      return loadFrameworkUpdate();
    }
    uploadButton.disabled = true; progress.hidden = false;
    try {
      const result = await apiData('/api/admin/framework-update/uploads', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file,
      });
      frameworkUpdateNotice = { kind: 'good', text: `已上传 ${result.upload.original_name}，先运行检查才能安装。` };
    } catch (error) {
      frameworkUpdateNotice = { kind: 'bad', text: `上传失败：${error.message ?? error}` };
    }
    await loadFrameworkUpdate();
  }, !canWrite() || Boolean(data.active_job) || data.engine_locked);
  uploadWrap.append(input, uploadButton, progress); candidates.body.append(uploadWrap);
  // 只有还能走向安装的候选才留在主流程里。检查没通过的是死路，留在这里会一直堆着——
  // 设备上就积了几个月前失败的文件。但也不能直接不显示，否则那些文件永远删不掉，
  // 所以收进一个折叠项，连同「丢弃」一起。
  const busyNow = !canWrite() || Boolean(data.active_job) || data.engine_locked;
  const uploads = data.uploads ?? [];
  const actionable = uploads.filter((upload) => ['uploaded', 'preflight_passed'].includes(upload.status));
  const dead = uploads.filter((upload) => !['uploaded', 'preflight_passed', 'applied'].includes(upload.status));
  if (actionable.length) {
    candidates.body.append(...actionable.map((upload) => frameworkUploadCard(upload, data.current_build, busyNow)));
  }
  if (dead.length) {
    const failed = document.createElement('details');
    failed.append(text('summary', `检查未通过的文件（${dead.length}）`));
    for (const upload of dead) failed.append(frameworkUploadCard(upload, data.current_build, busyNow));
    candidates.body.append(failed);
  }

  const recovery = section('恢复上一个版本');
  if (!data.last_good?.build) recovery.body.append(text('p', '没有已验证的上一版本备份，无法恢复。', 'empty'));
  else {
    recovery.body.append(valueRow('上一个构建', data.last_good.build), valueRow('保存于', data.last_good.created_at ? new Date(data.last_good.created_at).toLocaleString() : 'n/a'),
      valueRow('备份时的健康状态', data.last_good.health ?? 'n/a'));
    recovery.body.append(actionButton('恢复上一个版本', 'danger-text', () => runFrameworkRollback(data.last_good, data.current_build),
      !canWrite() || Boolean(data.active_job) || data.engine_locked));
  }

  // 作业进度与更新历史都是过程信息，统一在 Status / Logs 一处出现。
  // 之前 Package 的作业列表已经这样收拢过，Framework 自己的却漏在了这里。
  replacePage(update.card, candidates.card, recovery.card);
  if (data.active_job || data.engine_locked) frameworkUpdatePollTimer = setTimeout(() => loadFrameworkUpdate(), 1500);
}

/**
 * Framework 的作业进度与更新历史，供 Status / Logs 使用。
 *
 * 这些是过程信息：出问题时要查，顺利时不需要。放在 Framework Update 页上，等于每次
 * 想升个级都先读一遍与决定无关的记录。Package 的作业列表早就收拢到 Logs 了，
 * Framework 自己的当时漏了。
 */
function renderFrameworkOperations(data) {
  const wrap = document.createElement('div');
  const jobs = section('Framework 操作进度', null, { collapsible: true, collapsed: !data.active_job });
  if (!data.jobs?.length) jobs.body.append(text('p', '还没有从控制台发起过 Framework 操作。', 'empty'));
  else jobs.body.append(...data.jobs.slice(0, 8).map(frameworkJobCard));
  const history = section('Framework 更新历史', null, { collapsible: true, collapsed: true });
  if (!data.history?.length) history.body.append(text('p', '更新引擎没有留下记录。', 'empty'));
  else history.body.append(...data.history.map(frameworkHistoryCard));
  wrap.append(jobs.card, history.card);
  return wrap;
}

async function loadFrameworkUpdate() {
  try {
    renderFrameworkUpdate(await apiData('/api/admin/framework-update'));
  } catch (error) {
    if (!frameworkUpdateReconnectSince) frameworkUpdateReconnectSince = Date.now();
    const seconds = Math.max(1, Math.floor((Date.now() - frameworkUpdateReconnectSince) / 1000));
    const reconnect = document.createElement('div'); reconnect.className = 'reconnect-state';
    reconnect.append(text('p', '正在重新连接 Framework。外部更新引擎仍在运行，状态恢复后会重新出现在这里。', 'alert warning'),
      text('small', `Waiting ${seconds}s…`), document.createElement('progress'));
    replacePage(reconnect);
    frameworkUpdatePollTimer = setTimeout(() => loadFrameworkUpdate(), 1500);
  }
}

/**
 * 就地升級：走與 Available 相同的 registry 下載，下載完成後由既有的 check/install
 * 作業鏈接手。跳去 Available 讓使用者自己找同一個包，只是多兩次點擊。
 */
async function startPackageUpgrade(item, targetVersion) {
  const entry = registryByRepository.get(normalizeRepository(item.repository));
  const version = entry?.versions?.find((v) => v.version === targetVersion) ?? entry?.versions?.[0];
  const file = version?.files?.find((f) => f.kind === 'source_tar' && f.name.endsWith('.tar.gz'));
  if (!file) {
    packageNotice = { kind: 'bad', text: `${item.name} ${targetVersion} 沒有可用的來源封存。` };
    return loadPackageManager();
  }
  try {
    await apiData('/api/admin/package-registry/download', {
      method: 'POST',
      body: JSON.stringify({
        source: entry.source, repository: entry.repository,
        version: version.version, kind: file.kind, file: file.name,
      }),
    });
    packageNotice = { kind: 'good', text: `已下載 ${item.name} ${targetVersion}；檢查通過後即可安裝。` };
  } catch (error) {
    packageNotice = { kind: 'bad', text: `升級 ${item.name}：${error.message ?? error}` };
  }
  return loadPackageManager();
}

/** 把已安裝的版本派生成工作區專案並掛載——開發從一個能跑的副本開始，而不是空目錄。 */
async function startPackageDev(item) {
  const slug = String(item.id).split('.').pop();
  try {
    let created;
    try {
      created = await apiData('/api/admin/workspaces', {
        method: 'POST',
        body: JSON.stringify({ slug, package_id: item.id, from_dir: item.installed_dir }),
      });
    } catch (error) {
      // 專案已存在是**正常**情況：再點一次 Dev 應該掛上既有副本，而不是報一個
      // 只有路徑的紅字讓人猜發生了什麼。
      if (error?.data?.error !== 'already_exists') throw error;
      created = { path: error.data.detail };
      packageNotice = { kind: 'good', text: `Workspace 已有 ${slug}，直接掛載既有副本。` };
    }
    await apiData('/api/dev/packages', {
      method: 'POST',
      body: JSON.stringify({ package_id: item.id, workspace: created.path, slug }),
    });
    packageNotice = { kind: 'good', text: `已在 Workspace 建立並掛載 ${slug}；正式版仍在服務。` };
  } catch (error) {
    packageNotice = { kind: 'bad', text: `建立開發副本：${error.message ?? error}` };
  }
  return loadPackageManager();
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
      ['会停止的服务', item.services.length ? item.services.join(', ') : 'none declared'],
      ['配置 / 数据', 'preserved'],
      ['提供者绑定 / 期望状态', 'preserved'],
      ['失败时的行为', rollback ? 'Package Manager post-check reports failure' : 'operation result remains in job history'],
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
      ['Package 版本', identity.version],
      ['Target', identity.target],
      ['File SHA-256', upload.sha256],
      ['会停止的服务', identity.services?.length ? identity.services.join(', ') : 'none declared'],
      ['配置 / 数据', 'preserved'],
      ['失败时的行为', current ? 'the previous version is restored automatically' : 'the incomplete install is removed'],
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
    title: '丢弃已上传的安装包',
    label: '丢弃',
    details: [
      ['文件', upload.original_name],
      ['File SHA-256', upload.sha256],
      ['已安装的 Package', 'unchanged'],
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

/**
 * Registry 以 repository 為鍵，Installed 記錄也帶 repository——用它把兩邊對上。
 * 先前 Installed 只讀 manifest 的 publisher，Available 才查 official 名單，
 * 於是同一個 Package 在兩個分頁顯示不同的身份。
 */
let officialRepositories = new Set();

/**
 * Manifest 寫的是完整 URL（https://github.com/owner/repo），Registry 用的是 owner/repo。
 * 直接比對永遠不相等——先正規化成 owner/repo 再比。
 */
function normalizeRepository(value) {
  if (!value) return null;
  return String(value)
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isOfficialPackage(item) {
  const key = normalizeRepository(item.repository);
  return Boolean(key && officialRepositories.has(key));
}

function packageAdminName(item) {
  const title = item.admin_title ?? item.name ?? item.id;
  if (isOfficialPackage(item)) return `${title} [Official]`;
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

const packageOpenLink = (href, { newTab = false } = {}) => linkButton('打开', href, 'primary', { newTab });

function packageSettingLink(item) {
  const link = linkButton('设置', `/admin/packages/settings#${packageSettingAnchor(item.id)}`);
  link.setAttribute('aria-label', `${packageAdminName(item)} 的设置`);
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
  meta.append(valueRow('运行时', item.runtime ?? 'n/a'), valueRow('API 端口', item.ports?.length ? item.ports.map((p) => `${p.id}:${p.port}`).join(', ') : 'none'));
  card.append(meta);
  // 有新版本時，卡片先給一條橫幅——按鈕在一排六格裡，不橫幅的話很容易被略過。
  const upgrade = packageUpgrade(item);
  if (upgrade) {
    card.append(text('p', `有新版本 ${upgrade}（目前 ${item.version}）`, 'alert warning package-upgrade-banner'));
  }
  // 六格等寬、位置固定：不可用的置灰而不是消失，否則按鈕會隨狀態跳位，
  // 使用者每次都要重新找「Uninstall」在哪。
  const actions = document.createElement('div');
  actions.className = 'button-row package-card-actions six-up';
  actions.append(item.webui
    ? packageOpenLink(item.webui, { newTab: true })
    : actionButton('打开', '', () => {}, true));
  actions.append(packageSettingLink(item));
  actions.append(actionButton('更新', 'primary',
    () => startPackageUpgrade(item, upgrade), !canWrite() || !upgrade));
  actions.append(actionButton('开发', '',
    () => startPackageDev(item), !canWrite() || !item.installed_dir));
  actions.append(actionButton('回滚', '',
    () => startInstalledAction(item, 'rollback'), !canWrite() || !item.previous_version));
  actions.append(actionButton('卸载', 'danger-text',
    () => startInstalledAction(item, 'uninstall'), !canWrite()));
  card.append(actions);
  const details = document.createElement('details'); details.className = 'inline-details';
  details.append(Object.assign(document.createElement('summary'), { textContent: '版本详情' }),
    text('small', `SHA ${item.archive_sha256 ?? 'n/a'} · installed ${item.installed_at ?? 'n/a'}`));
  card.append(details);
  return card;
}

async function loadAdapters() {
  try {
    const data = await apiData('/api/admin/package-manager');
    const panel = section('Adapter 目录');
    panel.body.append(text('p', 'Adapter 是 Package 与设备、引擎、外部 API 之间的桥接。它们的端口和生命周期仍由 Package 管理负责。', 'description'));
    const adapters = (data.packages ?? []).filter((item) => item.types?.includes('adapter'));
    if (!adapters.length) panel.body.append(text('p', '还没有安装任何 Adapter。', 'empty'));
    else {
      const grid = document.createElement('div'); grid.className = 'package-grid';
      grid.append(...adapters.map(renderPackageCard)); panel.body.append(grid);
    }
    replacePage(panel.card);
  } catch (error) {
    const panel = section('Adapter 目录');
    panel.body.append(text('p', `Could not load Adapters: ${error.message ?? error}`, 'alert error'));
    replacePage(panel.card);
  }
}

function renderInstalledPackages(data) {
  const wrap = document.createElement('div');
  if (data.broken?.length) wrap.append(text('div', `${data.broken.length} Installed Root record(s) need review. See Recent operations for the exact failure.`, 'alert error'));
  const packages = (data.packages ?? []).filter(packageMatches);
  if (!data.packages?.length) wrap.append(text('p', '还没有安装任何 Package，可以从下面的文件安装。', 'empty'));
  else if (!packages.length) wrap.append(text('p', '没有符合当前搜索或筛选的 Package。', 'empty'));
  else {
    const grid = document.createElement('div'); grid.className = 'package-grid';
    grid.append(...packages.map(renderPackageCard)); wrap.append(grid);
  }
  const candidates = data.uploads?.filter((u) => u.status !== 'installed') ?? [];
  if (candidates.length) {
    wrap.append(text('h3', '待安装'), text('p', '已经下载、还没装上的安装包在这里。不在已验证列表里的文件，需要你明确确认风险。', 'description'));
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
    statusRow('状态', packageUploadStatus(upload),
      upload.status === 'preflight_passed' ? 'good' : upload.status === 'preflight_failed' ? 'bad' : 'neutral'),
  );
  if (id) {
    box.append(
      valueRow('Package ID', id.id),
      valueRow('目标机型', id.target),
      valueRow('类型', id.types?.join(', ') || 'n/a'),
    );
  }
  if (upload.origin) {
    box.append(valueRow('来源', `${upload.origin.repository} · ${upload.origin.version}`));
  }
  box.append(valueRow('来源可信度', upload.registry_verified === true ? 'Verified catalog hash' : 'Not in verified catalog'));
  if (upload.preflight) {
    const missing = (upload.preflight.external ?? []).filter((x) => x.ok === false && x.required);
    box.append(
      valueRow('机型判定', upload.preflight.target?.verdict ?? 'n/a'),
      valueRow('依赖', missing.length ? missing.map((x) => x.id).join(', ') : 'satisfied'),
    );
  }
  const actions = document.createElement('div');
  actions.className = 'button-row';
  if (upload.status === 'preflight_passed') {
    actions.append(actionButton('安装', 'primary', () => installUpload(upload)));
  } else if (upload.status === 'preflight_failed' || upload.status === 'uploaded') {
    actions.append(actionButton('重新检查', '', () => retryPreflight(upload)));
  }
  if (!['installed', 'install_failed'].includes(upload.status)) {
    actions.append(actionButton('丢弃', 'danger-text', () => discardUpload(upload)));
  }
  box.append(actions);
  return box;
}

function packageUploadStatus(upload) {
  return ({
    uploaded: '检查中',
    preflight_passed: '可以安装',
    preflight_failed: '检查未通过',
    installed: '已安装',
    install_failed: '安装失败',
  })[upload.status] ?? stateWord(String(upload.status ?? '').replaceAll('_', ' '));
}

/**
 * Installed 版本與 Registry 最新已驗證版本的比對結果。
 * 回傳可升級的目標版本，或 null。比較用數字段而非字串，避免 0.10 < 0.9。
 */
let registryByRepository = new Map();

function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function packageUpgrade(item) {
  if (!item.repository) return null;
  const entry = registryByRepository.get(normalizeRepository(item.repository));
  const latest = entry?.latest_verified_version ?? entry?.latest_version;
  if (!latest || !item.version) return null;
  return compareSemver(latest, item.version) > 0 ? latest : null;
}

/** 每次拿到 package-manager 快照時重建索引；官方名單與可升級判定都靠它。 */
/** 保证 Official 索引可用，不管用户是从哪一页进来的。索引已经建立就不再重复取。 */
async function ensureRegistryIndex() {
  if (officialRepositories.size) return;
  try { indexRegistry(await apiData('/api/admin/package-manager')); }
  catch { /* 目录拿不到时退回没有标识，而不是整页失败 */ }
}

function indexRegistry(data) {
  registryByRepository = new Map();
  officialRepositories = new Set();
  for (const entry of data.registry?.packages ?? []) {
    const key = normalizeRepository(entry.repository);
    registryByRepository.set(key, entry);
    if (entry.official?.length) officialRepositories.add(key);
  }
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
  // 這些欄位大多來自上游 Registry，未填就是空。只剩一個 Official 時要說清楚
  // 「是上游沒申報」，而不是讓人以為介面漏顯示了。
  if (rows.length <= (details.official?.length ? 1 : 0)) {
    rows.push(text('p',
      '此 Package 未申報依賴、權限、網路、資料存取、能力、連接埠或授權等公開資訊。',
      'empty'));
  }
  container.append(...rows);
}

function renderRegistry(data) {
  const wrap = document.createElement('div');
  const registry = data.registry ?? { status: 'not_fetched', packages: [] };
  wrap.append(text('p', '这些是已验证、可以安装的 Package。安装前可以点卡片上的 ℹ️ 看它声明了什么。', 'description'));
  if (registry.status !== 'ready' && registry.status !== 'stale') {
    wrap.append(text('p', '这台设备还没有载入过目录。', 'empty'));
    return wrap;
  }
  if (registry.status === 'stale') {
    wrap.append(text('p', `Showing the last cached catalog. Refresh failed: ${registry.error?.code ?? 'registry unavailable'}.`, 'alert warning'));
  }
  if (registry.fetched_at) {
    wrap.append(text('small', `${tr('更新于')} ${new Date(registry.updated_at ?? registry.generated_at ?? registry.fetched_at).toLocaleString()}`, 'meta'));
  }
  if (!registry.packages?.length) {
    wrap.append(text('p', 'Registry 没有返回任何 Package。', 'empty'));
    return wrap;
  }
  const grid = document.createElement('div'); grid.className = 'package-grid registry-grid';
  // Framework 不是可安裝的 Package——它有自己的更新流程（System → Framework Update）。
  // 混在包列表裡只會讓人誤以為可以像裝包一樣裝它。
  const installable = registry.packages.filter((item) => !item.types?.includes('framework'));
  if (!installable.length) {
    wrap.append(text('p', 'Registry 没有返回可安装的 Package。', 'empty'));
    return wrap;
  }
  for (const item of installable) {
    const card = document.createElement('article'); card.className = 'panel package-card registry-card';
    const version = item.versions?.find((entry) => entry.version === (item.latest_verified_version ?? item.latest_version)) ?? item.versions?.[0];
    const file = version?.files?.find((entry) => entry.kind === 'source_tar' && entry.name.endsWith('.tar.gz'));
    card.append(text('b', registryDisplayName(item)), text('small', item.repository, 'meta'));
    if (item.description) card.append(text('p', item.description, 'package-card-description'));
    card.append(valueRow('最新已验证', version?.version ?? item.latest_verified_version ?? 'n/a'),
      valueRow('发布时间', item.latest_verified_published_at ?? version?.published_at ?? 'n/a'));
    if (file) {
      // 檔名恆為 source.tar.gz，沒有資訊量；大小有。
      card.append(valueRow('源码包', formatBytes(file.size)));
      const detailBox = document.createElement('div'); detailBox.className = 'registry-details'; detailBox.hidden = true;
      const selection = { source: item.source, repository: item.repository, version: version.version, kind: file.kind, file: file.name };
      let publicDetailsLoaded = false;
      const download = actionButton('下载', 'primary', async () => {
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
              title: '手动下载 Package',
              manual: error.data.manual,
              nextStep: 'After transferring the archive to this device, use Install from file to upload and install it after the normal Package checks.',
            });
          }
          packageNotice = { kind: 'bad', text: `Registry download: ${error.message ?? error}` };
        }
        await loadPackageManager();
      }, !canWrite() || Boolean(data.active_job));
      // 安全資訊的價值在**可查**，不在**強制**。先前 Download 被 Details 門禁擋住，
      // 效果只是多一次點擊，沒有人因此真的讀了權限。改為預設收起、隨時可展開。
      const disclosure = document.createElement('details');
      disclosure.className = 'info registry-disclosure';
      const summary = document.createElement('summary');
      summary.textContent = 'ℹ️ 詳細資訊';
      summary.title = '依賴、權限、網路與授權';
      disclosure.append(summary, detailBox);
      detailBox.hidden = false;
      disclosure.addEventListener('toggle', async () => {
        if (!disclosure.open || publicDetailsLoaded) return;
        detailBox.replaceChildren(text('p', '讀取中…', 'empty'));
        try {
          const result = await apiData('/api/admin/package-registry/details', { method: 'POST', body: JSON.stringify(selection) });
          renderRegistryDetails(detailBox, { ...result.details, official: item.official });
          publicDetailsLoaded = true;
        } catch (error) {
          detailBox.replaceChildren(text('p', `讀取詳細資訊失敗：${error.message ?? error}`, 'alert error'));
        }
      });
      const actions = document.createElement('div'); actions.className = 'button-row';
      actions.append(download);
      card.append(disclosure, actions);
    } else {
      card.append(text('p', '这个版本没有固定的源码包。', 'empty'));
    }
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

function renderUpload(data) {
  const wrap = document.createElement('div');
  wrap.append(text('p', '选择一个 Package 安装包。Framework 会先核对它的身份与依赖，通过后才允许安装。',
    'description'));
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.tar.gz,application/gzip'; input.id = 'package-file';
  const progress = document.createElement('progress');
  progress.hidden = true;
  const upload = actionButton('添加并检查', 'primary', async () => {
    const file = input.files?.[0];
    if (!file) {
      packageNotice = { kind: 'bad', text: '请先选择一个 .tar.gz 安装包。' };
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
    wrap.append(text('h3', '最近上传'), ...data.uploads.slice(0, 5).map(preflightSummary));
  }
  return wrap;
}

/**
 * Package 生命週期作業。**只在 Status → Logs 出現一次**——
 * 每個頁面各掛一份的話，同一批作業會在四處重複，而使用者要找失敗原因時
 * 反而不知道該看哪一份。
 */
function renderJobs(data) {
  // 折叠交给 section 统一处理。先前这里自己套了一层 <details>，于是同一页里
  // 只有这一块能收起来，别的卡片不能——用户无从知道哪一块是可以收的。
  const panel = section('Package 操作', null, { collapsible: true, collapsed: !data.active_job });
  const body = panel.body;
  if (!data.jobs?.length) body.append(text('p', '还没有 Package 生命周期作业。', 'empty'));
  for (const job of data.jobs?.slice(0, 8) ?? []) {
    const details = document.createElement('details');
    details.className = 'job-row';
    if (data.active_job?.id === job.id) details.open = true;
    const summary = document.createElement('summary');
    summary.append(
      text('b', `${stateWord(job.action)} · ${job.target.package_id ?? job.target.upload_id}`),
      text('span', `${stateWord(job.stage)} · ${stateWord(job.status)}`, `status ${job.status === 'success' ? 'good' : job.status === 'failed' ? 'bad' : 'neutral'}`),
    );
    details.append(summary);
    if (['queued', 'running'].includes(job.status)) details.append(document.createElement('progress'));
    if (job.output) details.append(text('pre', job.output));
    if (job.error) details.append(text('p', job.error, 'alert error'));
    body.append(details);
  }
  return panel.card;
}

function renderPackageManager(data) {
  if (packagePollTimer) { clearTimeout(packagePollTimer); packagePollTimer = null; }
  indexRegistry(data);
  packageReconnectSince = 0;
  const panel = section('Package 管理');
  panel.body.append(text('p', '「已安装」是这台设备上有的，「可安装」是已验证、可以装的。也可以直接从文件安装。', 'description'));
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
  // 目錄刷新是**面板級**動作：Framework Update 與 Packages 讀的是同一份快取，
  // 把入口埋在 Available 分頁裡，等於讓另一個頁面永遠拿不到最新資料。
  panel.head?.append(actionButton('更新列表', 'primary', async () => {
    try {
      const result = await apiData('/api/admin/package-registry/refresh', { method: 'POST', body: '{}' });
      packageNotice = { kind: 'good', text: `列表已更新（registry ${result.registry_version ?? '?'}）。` };
    } catch (error) {
      packageNotice = { kind: 'bad', text: `更新列表失敗：${error.message ?? error}` };
    }
    await loadPackageManager();
  }, !canWrite() || Boolean(data.active_job)));
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  const content = document.createElement('div');
  const views = {
    installed: () => renderInstalledPackages(data),
    registry: () => renderRegistry(data),
    upload: () => renderUpload(data),
  };
  // Installed 的括號改為**可升級數**——包總數在列表裡一眼可見，不需要重複；
  // 真正需要一眼看到的是「有幾個該更新」。為 0 時不顯示括號，避免噪音。
  const upgradable = (data.packages ?? []).filter(packageUpgrade).length;
  for (const [id, label] of [['installed', upgradable ? `已安装（${upgradable} 个可更新）` : '已安装'],
    ['registry', '可安装'],
    ['upload', '从文件安装']]) {
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
  replacePage(panel.card);
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
      text('p', '正在重新连接 Framework。作业仍在继续，结果恢复后会重新出现在这里。', 'alert warning'),
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
      ['影响', 'Closes active Package clients, stops its runtime, kills its owned session if applicable, then reloads the current version.'],
      ['持久数据', 'Package configuration and data are preserved.'],
    );
  } else if (action === 'disable') {
    details.push(
      ['影响', 'Disables the Package, removes its active routes and menu entries, and kills its owned runtime session.'],
      ['持久数据', 'Package configuration and data are preserved.'],
    );
  } else {
    details.push(
      ['影响', 'Loads this Package and starts its App runtime. Termux Terminal creates a fresh termux-os tmux session.'],
      ['持久数据', 'Package configuration and data are preserved.'],
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
    box.append(text('p', '这个 Package 没有声明 HTTP 端口。', 'empty'));
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
  const save = actionButton('保存端口设置', 'primary', async () => {
    if (draft.some((port) => port.visibility === 'lan')) {
      const accepted = await confirmAction({
        title: '把 Package API 暴露到局域网',
        label: '开放局域网访问',
        details: [
          ['影响', 'The Package port will bind to the device network instead of loopback after restart.'],
          ['安全', 'Any device able to reach this network may probe the Package API. Use only a trusted network.'],
          ['终止性警告', 'A Package such as Termux Terminal may expose an interactive shell and persistent tmux session.'],
          ['撤销方式', 'Return the port to Device only and restart the Package to close the LAN listener.'],
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
  card.append(valueRow('版本', item.version), valueRow('服务', item.services?.join(', ') || 'none'));
  if (item.loader_status === 'failed' || item.loader_status === 'incompatible') {
    card.append(text('p', item.error ?? `Package status: ${item.loader_status}`, 'alert error'));
  }
  const editor = packagePortEditor(item, policy);
  card.append(editor.box);
  const actions = document.createElement('div'); actions.className = 'button-row package-card-actions package-setting-actions';
  if (item.webui) actions.append(packageOpenLink(item.webui, { newTab: true }));
  actions.append(actionButton('重启', '', () => packageSettingAction(item, 'restart'), !canWrite() || !item.enabled || item.loader_status !== 'loaded'));
  if (item.enabled) actions.append(actionButton('停用', 'danger-text', () => packageSettingAction(item, 'disable'), !canWrite()));
  else actions.append(actionButton('启用', 'primary', () => packageSettingAction(item, 'enable'), !canWrite()));
  card.append(actions);
  return card;
}

function renderPackageSettings(data) {
  const panel = section('Package 设置');
  panel.body.append(text('p', '以整个 Package 为单位控制。端口改动会存入私有登记表，在该 Package 重启后生效；切到「局域网」会让支持的 Package 把 API 绑到设备网络上。', 'description'));
  if (packageSettingNotice) panel.body.append(text('p', packageSettingNotice.text, `alert ${packageSettingNotice.kind}`));
  panel.body.append(valueRow('Package 端口范围', `${data.policy.range.start}–${data.policy.range.end}`),
    valueRow('核心保留端口', data.policy.reserved.join(', ')),
    text('p', '「仅本机」只用 loopback。「局域网」会把 Package API 暴露在 0.0.0.0 上。重启会断开正在进行的 Package 会话，但该 Package 的持久配置与数据都会保留。', 'muted'));
  if (!data.packages?.length) panel.body.append(text('p', '没有可配置的已安装 Package。', 'empty'));
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
    // Official 标识来自 Registry 目录，而那份索引原本只在 Package 管理页渲染时才建立。
    // 直接打开设置页时它是空的，于是同一个包在一页上有标识、另一页上没有。
    // 索引由需要它的页面各自确保，不再依赖用户先访问过哪一页。
    const [data] = await Promise.all([
      apiData('/api/admin/package-settings'),
      ensureRegistryIndex(),
    ]);
    renderPackageSettings(data);
  } catch (error) {
    const panel = section('Package 设置');
    panel.body.append(text('p', `Could not load Package Setting: ${error.message ?? error}`, 'alert error'));
    replacePage(panel.card);
  }
}
