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

/**
 * 引导安装：下载 → 检查 → 报告 → 用户同意 → 安装 → 重启恢复。
 *
 * 先前点完「下载」只会得到一句「去某某页面看看」，用户要自己找到卡片、点检查、再点安装；
 * 而且点下去到第一个反馈之间是空白的——大包要几十秒，用户不知道命令有没有被收到。
 * 所以进度界面在**点击的瞬间**就出现，与「有没有开始下载」无关；能不能装成功是之后的事。
 *
 * Framework 与 Package 共用这一条流程：两者的差别只是三个回调，不是两套界面。
 */
const installFlow = {
  steps: [],
  cancel: null,
  preserveDirty: false,
  forceDirty: false,
  dependencyMode: 'local_only',
};

/**
 * ⭐ 关闭按钮的**行为绑一次，之后只换字**。
 *
 * 它一路上要当「取消」「关闭」「完成」，而先前每一步都只改 `textContent`——
 * 偏偏确认那一步结束时会把自己的监听器摘掉（它离开了确认这个角色，摘是对的），
 * 于是走到结尾改名成「完成」的那个按钮**一个处理器都没有**，点了毫无反应，
 * 只能刷新整页。
 *
 * ⚠ 形状：**一个控件被重新赋予角色，却没有被重新赋予行为**。不报错，看起来完全正常。
 * 所以这里反过来：关掉对话框这件事从头到尾都由同一个绑定负责，谁都不许摘；
 * 换角色的人只换标签，以及**额外**监听它。
 */
let installDismissBound = false;
function installDialogBindDismiss() {
  if (installDismissBound) return;
  $('install-cancel').addEventListener('click', () => $('install-dialog').close());
  installDismissBound = true;
}

function installDialogReset(title, steps) {
  installDialogBindDismiss();
  const dialog = $('install-dialog');
  $('install-title').textContent = tr(title);
  const list = $('install-steps');
  list.replaceChildren();
  installFlow.steps = steps.map((label) => {
    const item = document.createElement('li');
    item.textContent = tr(label);
    list.append(item);
    return item;
  });
  $('install-report').replaceChildren();
  $('install-report').hidden = true;
  $('install-warning').hidden = true;
  $('install-error').hidden = true;
  $('install-ack-wrap').hidden = true;
  $('install-ack').checked = false;
  $('install-confirm').hidden = true;
  installFlow.preserveDirty = false;
  installFlow.forceDirty = false;
  installFlow.dependencyMode = 'local_only';
  $('install-cancel').textContent = tr('取消');
  if (!dialog.open) dialog.showModal();
  return dialog;
}

const installStep = (index, state) => {
  installFlow.steps.forEach((item, i) => {
    item.classList.toggle('is-done', i < index || (i === index && state === 'done'));
    item.classList.toggle('is-active', i === index && state === 'active');
    item.classList.toggle('is-failed', i === index && state === 'failed');
  });
};

function installFail(message) {
  const error = $('install-error');
  error.textContent = message;
  error.hidden = false;
  $('install-cancel').textContent = tr('关闭');
  $('install-confirm').hidden = true;
}

/** 等用户在报告上点「同意并安装」。取消返回 false，流程就停在这里，不装。 */
function installAwaitConsent({
  rows, warning = null, acknowledgement = null, dirtyAcknowledgement = null,
  forceDirtyAcknowledgement = null,
  dependencyMode = 'local_only', blocked = false, label = '同意并安装',
}) {
  const report = $('install-report');
  report.replaceChildren(...rows.map(([key, value]) => valueRow(key, value)));
  report.hidden = false;
  if (warning) { $('install-warning').textContent = tr(warning); $('install-warning').hidden = false; }
  const ack = $('install-ack');
  if (acknowledgement) {
    $('install-ack-text').textContent = tr(acknowledgement);
    $('install-ack-wrap').hidden = false;
  }
  let dirtyAck = null;
  let forceDirtyAck = null;
  const makeDirtyChoice = (text, value) => {
    if (!text) return null;
    const dirtyLabel = document.createElement('label');
    dirtyLabel.className = 'confirm-ack';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'install-dirty-choice';
    input.value = value;
    const dirtyText = document.createElement('span');
    dirtyText.textContent = tr(text);
    dirtyLabel.append(input, dirtyText);
    report.append(dirtyLabel);
    return input;
  };
  if (dirtyAcknowledgement) dirtyAck = makeDirtyChoice(dirtyAcknowledgement, 'preserve');
  if (forceDirtyAcknowledgement) forceDirtyAck = makeDirtyChoice(forceDirtyAcknowledgement, 'force');
  const confirm = $('install-confirm');
  confirm.textContent = tr(label);
  confirm.hidden = blocked;
  const updateConsentState = () => {
    const dirtyChoiceRequired = Boolean(dirtyAcknowledgement || forceDirtyAcknowledgement);
    confirm.disabled = blocked
      || (Boolean(acknowledgement) && !ack.checked)
      || (dirtyChoiceRequired && !dirtyAck?.checked && !forceDirtyAck?.checked);
  };
  updateConsentState();
  const onAck = updateConsentState;
  ack.addEventListener('change', onAck);
  dirtyAck?.addEventListener('change', onAck);
  forceDirtyAck?.addEventListener('change', onAck);
  return new Promise((resolve) => {
    const done = (value) => {
      ack.removeEventListener('change', onAck);
      dirtyAck?.removeEventListener('change', onAck);
      forceDirtyAck?.removeEventListener('change', onAck);
      confirm.removeEventListener('click', onConfirm);
      $('install-cancel').removeEventListener('click', onCancel);
      resolve(value);
    };
    const onConfirm = () => {
      installFlow.preserveDirty = Boolean(dirtyAck?.checked);
      installFlow.forceDirty = Boolean(forceDirtyAck?.checked);
      installFlow.dependencyMode = dependencyMode;
      confirm.hidden = true;
      $('install-warning').hidden = true;
      done(true);
    };
    // ⚠ 只负责「使用者不同意」这件事；关闭对话框由那个从不摘掉的绑定做。
    const onCancel = () => done(false);
    confirm.addEventListener('click', onConfirm);
    $('install-cancel').addEventListener('click', onCancel);
  });
}

/** 轮询一个作业直到它结束。作业消失（Framework 重启把它带走）也算结束，由调用方判定结果。 */
async function installAwaitJob(url, { onOutput = null, timeoutMs = 600000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) return { status: 'timeout' };
    await new Promise((resolve) => setTimeout(resolve, 1200));
    let job = null;
    try {
      const response = await api(url);
      if (response.ok) job = (await response.json()).job;
    } catch {
      // 安装会让 Framework 重启，连不上是过程的一部分，不是失败。
      continue;
    }
    if (!job) continue;
    if (onOutput && job.output) onOutput(job.output);
    if (!['queued', 'running'].includes(job.status)) return job;
  }
}

/** Framework 恢复：安装会重启它，页面要等到它重新应答才算完成。 */
async function installAwaitFramework(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (response.ok) return true;
    } catch { /* 还没起来 */ }
  }
  return false;
}

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

function frameworkUpdateConsent(upload, currentBuild) {
  return {
    rows: [
      ['当前构建', currentBuild ?? '未知'],
      ['更新文件', upload.original_name],
      ['目标构建', upload.preflight?.candidate_build ?? 'validated by formal check'],
      ['File SHA-256', upload.sha256],
      ['会保留', 'Installed Packages, persistent config/data and assets'],
      ['成功判据', 'Browser Login, admin menu, integrity, Package inventory and boundary comparison'],
      ['失败时的行为', 'the existing engine automatically restores the previous version and records the evidence'],
    ],
    warning: '安装过程中 Framework 会重启，控制台会短暂中断。',
    label: '同意并安装',
  };
}

async function runFrameworkPreflight(upload) {
  installDialogReset('安装 Framework 更新', ['检查', '安装', '重启恢复']);
  installStep(0, 'active');
  let started;
  try {
    started = await apiData(`/api/admin/framework-update/uploads/${encodeURIComponent(upload.id)}/preflight`, {
      method: 'POST', body: '{}',
    });
  } catch (error) {
    installStep(0, 'failed');
    installFail(`检查：${error.message ?? error}`);
    await loadFrameworkUpdate();
    return undefined;
  }

  const finished = await installAwaitJob(`/api/admin/framework-update/jobs/${started.job.id}`);
  const snapshot = await apiData('/api/admin/framework-update').catch(() => null);
  const fresh = snapshot?.uploads?.find((item) => item.id === upload.id) ?? upload;
  if (finished.status !== 'success' || fresh.status !== 'preflight_passed') {
    installStep(0, 'failed');
    installFail(finished.error ?? finished.output ?? fresh.preflight?.output ?? '检查没有通过，这个安装包不能安装。');
    await loadFrameworkUpdate();
    return undefined;
  }
  installStep(0, 'done');
  return runFrameworkUpdate(fresh, snapshot?.current_build ?? '未知', { dialogAlreadyOpen: true, stepOffset: 1 });
}

async function runFrameworkUpdate(upload, currentBuild, { dialogAlreadyOpen = false, stepOffset = 0 } = {}) {
  if (!dialogAlreadyOpen) {
    installDialogReset('安装 Framework 更新', ['安装', '重启恢复']);
    installStep(0, 'active');
  }
  const accepted = await installAwaitConsent(frameworkUpdateConsent(upload, currentBuild));
  if (!accepted) return;
  try {
    const result = await apiData(`/api/admin/framework-update/uploads/${encodeURIComponent(upload.id)}/update`, {
      method: 'POST', body: JSON.stringify({ confirm_sha256: upload.sha256 }),
    });
    const finished = await installAwaitJob(`/api/admin/framework-update/jobs/${result.job.id}`);
    if (finished.status !== 'success') {
      installStep(stepOffset, 'failed');
      installFail(finished.error ?? finished.output ?? '更新失败，上一个版本已经恢复。');
      await loadFrameworkUpdate();
      return;
    }
  } catch (error) {
    installStep(stepOffset, 'failed');
    installFail(`更新：${error.message ?? error}`);
    await loadFrameworkUpdate();
    return;
  }
  installStep(stepOffset, 'done');
  installStep(stepOffset + 1, 'active');
  const alive = await installAwaitFramework();
  installStep(stepOffset + 1, alive ? 'done' : 'failed');
  if (!alive) {
    installFail('更新已经执行，但 Framework 在两分钟内没有恢复应答。');
    await loadFrameworkUpdate();
    return;
  }
  $('install-cancel').textContent = tr('完成');
  frameworkUpdateNotice = { kind: 'good', text: `Framework 已更新到 ${upload.preflight?.candidate_build ?? '新版本'}。` };
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

  // 与 Package 一样：点下去立刻有反馈，之后一路走到底，不再把用户丢回页面自己接力。
  installDialogReset(`${action.title} ${target.version}`, ['下载', '检查与安装', '重启恢复']);
  installStep(0, 'active');

  const consented = await installAwaitConsent({
    rows: [
      ['当前版本', currentBuild ?? registry.current_version ?? '未知'],
      [target.relation === 'older' ? '降级到' : '将安装', target.version],
      ['来源', `${registry.repository} · ${target.selection?.upstream_ref ?? '已验证来源'}`],
      ['大小', formatBytes(target.size)],
      ['File SHA-256', target.sha256 ?? '未提供'],
      ['会保留', 'Framework 配置、凭证、Package、模型与缓存'],
      ['失败时的行为', '安装器会先恢复上一个运行时，再报告失败'],
    ],
    warning: target.relation === 'older'
      ? '旧版本可能读不懂当前版本写下的配置；如果起不来，用「恢复上一个版本」退回。安装过程中控制台会短暂中断。'
      : '安装过程中 Framework 会重启，控制台会短暂中断。',
    label: action.label,
  });
  if (!consented) return loadFrameworkUpdate();

  let job;
  try {
    const result = await apiData('/api/admin/framework-update/registry', {
      method: 'POST', body: JSON.stringify({ version: target.version, confirm_version: target.version }),
    });
    job = result.job;
  } catch (error) {
    installStep(0, 'failed');
    installFail(String(error?.message ?? error));
    if (error?.data?.manual?.release_url) {
      $('install-dialog').close();
      await showManualDownloadDialog({
        title: '手动下载 Framework 更新',
        manual: error.data.manual,
        nextStep: '把安装包传到这台设备后，用「从文件安装」上传，它会走同样的检查与安装流程。',
      });
    }
    return loadFrameworkUpdate();
  }
  installStep(0, 'done');

  installStep(1, 'active');
  const finished = await installAwaitJob(`/api/admin/framework-update/jobs/${job.id}`);
  if (finished.status && !['success'].includes(finished.status)) {
    installStep(1, 'failed');
    installFail(finished.error ?? '更新失败，上一个版本已经恢复。');
    return loadFrameworkUpdate();
  }
  installStep(1, 'done');

  installStep(2, 'active');
  const alive = await installAwaitFramework();
  installStep(2, alive ? 'done' : 'failed');
  if (!alive) {
    installFail('更新已经执行，但 Framework 在两分钟内没有恢复应答。');
    return loadFrameworkUpdate();
  }
  $('install-cancel').textContent = tr('完成');
  frameworkUpdateNotice = { kind: 'good', text: `Framework 已更新到 ${target.version}。` };
  await loadFrameworkUpdate();
  return undefined;
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

  // 与上面的卡片是同一件事——当前是什么版本、有没有更新的，分成两张只会把当前版本说两遍。
  const registry = update;
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
    // 当前版本上面已经说过了，这里只补「从哪里取」。
    registry.body.append(valueRow('来源', frameworkCatalog.repository));

    // 掛載中的 Dev Runtime 會擋下更新。把「停止全部挂载」直接放在這裡——
    // 讓使用者為了更新而去別的頁面翻找（或更糟，去開 Termux）是把流程做了一半。
    const controls = document.createElement('div'); controls.className = 'button-row';
    if (data.dev_watchers?.length) {
      controls.append(actionButton(`停止全部监视（${data.dev_watchers.length}）`, '', async () => {
        for (const mount of data.dev_watchers) {
          try {
            await apiData(`/api/dev/packages/${encodeURIComponent(mount.package_id)}/stop`,
              { method: 'POST', body: '{}' });
          } catch (error) {
            frameworkUpdateNotice = { kind: 'bad', text: `停止 ${mount.package_id} 失败：${error.message ?? error}` };
          }
        }
        frameworkUpdateNotice ??= { kind: 'good', text: '已停止全部监视；Package 内容不受影响，现在可以更新。' };
        await loadFrameworkUpdate();
      }, !canWrite()));
    }
    controls.append(refreshRegistryButton);
    registry.body.append(controls);

    // 列出全部已驗證版本，而不只是 latest。「已經是最新」不代表這頁沒事可做：
    // 檔案壞了要能重裝當前版本，新版有問題要能挑一個舊版裝回去。
    const busy = !canWrite() || Boolean(data.active_job) || data.engine_locked;
    // 只呈现一个决定：能不能升到更新的版本，或者重装当前这一版。
    // 把每个历史版本都摆出来，等于要用户在一串自己从没用过的版本号里找那一个有意义的；
    // 真要退回去，下面的「恢复上一个版本」才是有备份保证的路径。
    const versions = frameworkCatalog.versions ?? [];
    const actionable = versions.filter((entry) => entry.relation === 'newer' || entry.relation === 'current');
    if (!actionable.length) {
      registry.body.append(text('p',
        `目录里没有比 ${frameworkCatalog.current_version ?? data.current_build} 更新的版本。`, 'empty'));
    } else {
      const list = document.createElement('div'); list.className = 'version-list';
      for (const entry of actionable) {
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
        list.append(row);
      }
      registry.body.append(list);
    }
  }

  // 离线安装仍然需要（没有网络的设备只能这样装），但这一页不做文件管理器：
  // 只显示正在进行中的那一个。检查没通过的文件既不能装也不该留在这里让人以为要处理它——
  // 失败原因在上面的结果里说过，完整记录在 Status / Logs。
  const candidates = section('从文件安装');
  candidates.body.append(text('p', '没有网络时，可以在这里上传 Framework 的 .tar.gz 安装包。', 'description'));
  const uploadWrap = document.createElement('div'); uploadWrap.className = 'upload-row';
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.tar.gz,application/gzip';
  const progress = document.createElement('progress'); progress.hidden = true;
  const busyNow = !canWrite() || Boolean(data.active_job) || data.engine_locked;
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
  }, busyNow);
  uploadWrap.append(input, uploadButton, progress); candidates.body.append(uploadWrap);
  // 只显示最新的那一个。上传是一次一个的动作，同时列出好几个「等待检查」的旧文件，
  // 读的人会以为它们都还要处理——实际上它们只是没被清掉。
  const [current] = (data.uploads ?? []).filter((upload) => ['uploaded', 'preflight_passed', 'preflight_failed'].includes(upload.status));
  if (current) candidates.body.append(frameworkUploadCard(current, data.current_build, busyNow));

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
 * Package 的引导安装：下载 → 检查 → 报告 → 同意 → 安装 → 等 Framework 恢复。
 *
 * 「就地升级」与 Available 里的「安装」走同一条：区别只是从哪里拿到 selection，
 * 不是两套界面。下载完把用户丢回列表让他自己找卡片再点两次，是把一件事拆成三件。
 */
async function runGuidedPackageInstall({ selection, name, version }) {
  // 进度界面在点击的瞬间就出现，与下载有没有开始无关——用户先要知道命令被收到了。
  installDialogReset(`安装 ${name}`, ['下载', '检查', '安装', '完成']);
  installStep(0, 'active');

  let upload;
  try {
    const result = await apiData('/api/admin/package-registry/download', {
      method: 'POST', body: JSON.stringify(selection),
    });
    upload = result.upload;
  } catch (error) {
    installStep(0, 'failed');
    installFail(String(error?.message ?? error));
    if (error?.data?.manual?.release_url) {
      $('install-dialog').close();
      packageTab = 'upload';
      await showManualDownloadDialog({
        title: '手动下载 Package',
        manual: error.data.manual,
        nextStep: '把安装包传到这台设备后，用「从文件安装」上传，它会走同样的检查与安装流程。',
      });
    }
    return loadPackageManager();
  }

  return runGuidedInstallFromUpload(upload, name, { selection, version, stepOffset: 1 });
}

/**
 * 引导流程里「已经拿到安装包之后」的部分：检查 → 报告 → 同意 → 安装 → 等恢复。
 * 从 Registry 下载和从文件上传只是取得安装包的方式不同，之后完全一样。
 */
async function runGuidedInstallFromUpload(upload, name, { selection = null, version = null, stepOffset = 1 } = {}) {
  installStep(stepOffset, 'active');
  const checked = await installAwaitJob(`/api/admin/package-manager/jobs/${upload.job_id}`);
  const snapshot = await apiData('/api/admin/package-manager').catch(() => null);
  const fresh = snapshot?.uploads?.find((item) => item.id === upload.id) ?? upload;
  if (fresh.status !== 'preflight_passed') {
    installStep(stepOffset, 'failed');
    installFail(checked?.error ?? fresh.preflight?.error ?? '检查没有通过，这个安装包不能安装。');
    return loadPackageManager();
  }
  installStep(stepOffset, 'done');

  const identity = fresh.identity ?? {};
  const current = snapshot?.packages?.find((item) => item.id === identity.id);
  const localOnly = fresh.install_source !== 'registry';
  const dependencyMode = localOnly ? 'local_only' : (fresh.dependency_mode ?? 'registry');
  let dependencies = null;
  try {
    const details = await apiData(`/api/admin/package-manager/uploads/${encodeURIComponent(fresh.id)}/dependencies?dependency_mode=${encodeURIComponent(dependencyMode)}`);
    dependencies = details.dependencies ?? null;
  } catch (error) {
    installStep(stepOffset, 'failed');
    installFail(`依赖检查：${error.message ?? error}`);
    return loadPackageManager();
  }
  const dirty = current?.install_safety?.dirty === true;
  const dependencyBlocked = dependencies?.installable === false;
  const dependencyFailure = dependencyBlocked
    ? (localOnly
      ? '本地安装不会联网；请先在本机安装必需依赖：'
        + ` ${(dependencies.missing_local ?? dependencies.blocked ?? []).map((node) => node.id).join(', ')}`
      : `Registry 目录中没有可补齐的必需依赖：${(dependencies.missing_from_catalog ?? []).map((node) => node.id).join(', ')}`)
    : null;
  const consented = await installAwaitConsent({
    rows: [
      ['Package', identity.name ?? identity.id ?? name],
      ['Package ID', identity.id ?? '未知'],
      ['当前版本', current?.version ?? '未安装'],
      ['将安装', identity.version ?? version ?? '未知'],
      ['目标机型', identity.target ?? '未声明'],
      ['大小', formatBytes(fresh.size)],
      ['File SHA-256', fresh.sha256],
      ['安装方式', localOnly ? '本地归档（安装期间不访问 Registry）' : 'Registry 归档（按目录补充依赖）'],
      ['来源', fresh.origin
        ? `${fresh.origin.repository ?? selection?.repository ?? '本地文件'} · ${originPathLabel(fresh.origin.path)}`
        : '本地文件'],
      ['会停止的服务', identity.services?.length ? identity.services.join(', ') : '无'],
      ['配置 / 数据', '保留'],
      ['失败时的行为', current ? '自动恢复上一个版本' : '删除未完成的安装'],
      ...dependencyRows(dependencies),
    ],
    warning: dependencyFailure ?? '安装过程中 Framework 会重启，控制台会短暂中断。',
    acknowledgement: fresh.registry_verified === true
      ? null
      : '我知道这个安装包的 SHA-256 不在已验证列表里，仍然要装。',
    dirtyAcknowledgement: dirty
      ? `当前版本有 ${current.install_safety.change_count} 处本地修改；我同意先备份完整工作区，再安装新版本。`
      : null,
    forceDirtyAcknowledgement: dirty
      ? '我知道这会丢弃当前 Package 的全部本地修改、不创建备份，并继续强制覆盖。'
      : null,
    dependencyMode,
    blocked: dependencyBlocked,
  });
  if (!consented) return loadPackageManager();

  installStep(stepOffset + 1, 'active');
  let job;
  try {
    job = (await apiData(`/api/admin/package-manager/uploads/${fresh.id}/install`, {
      method: 'POST',
      body: JSON.stringify({
        confirm_sha256: fresh.sha256,
        ...(fresh.registry_verified === true ? {} : { confirm_unverified: true }),
        dependency_mode: installFlow.dependencyMode,
        ...(installFlow.preserveDirty ? { preserve_dirty: true } : {}),
        ...(installFlow.forceDirty ? { force_dirty: true } : {}),
      }),
    })).job;
  } catch (error) {
    installStep(stepOffset + 1, 'failed');
    installFail(String(error?.message ?? error));
    return loadPackageManager();
  }
  const installed = await installAwaitJob(`/api/admin/package-manager/jobs/${job.id}`);
  if (installed.status && installed.status !== 'success') {
    installStep(stepOffset + 1, 'failed');
    installFail(installed.error ?? '安装失败，之前的版本已经恢复。');
    return loadPackageManager();
  }
  installStep(stepOffset + 1, 'done');

  installStep(stepOffset + 2, 'active');
  const alive = await installAwaitFramework();
  installStep(stepOffset + 2, alive ? 'done' : 'failed');
  if (!alive) {
    installFail('安装完成了，但 Framework 在两分钟内没有恢复应答。');
    return loadPackageManager();
  }
  $('install-cancel').textContent = tr('完成');
  packageNotice = { kind: 'good', text: `${identity.name ?? name} ${identity.version ?? version ?? ''} 已安装。` };
  await loadPackageManager();
  return undefined;
}

const originPathLabel = (path) => ({
  github_direct: 'GitHub 直连',
  termux_os_registry: 'Termux-OS Registry',
}[path] ?? '已验证来源');

/** 就地升级：Core 已经选好归档，更新与安装共用同一条引导流程。 */
async function startPackageUpgrade(item) {
  const update = item.registry_update;
  const selection = update?.selection;
  if (!update?.update_available || !selection) {
    installDialogReset(`更新 ${item.name ?? item.id}`, ['下载', '检查', '安装', '完成']);
    installFail(update?.reason === 'no_installable_archive'
      ? 'Registry 找到了版本，但没有可安装的已验证归档。'
      : '当前没有可用的已验证更新，请刷新 Registry 后重试。');
    return undefined;
  }
  return runGuidedPackageInstall({
    selection,
    name: item.name ?? item.id,
    version: selection.version,
  });
}

/**
 * Development has two independent parts and the card treats them separately:
 *   provenance — sticky; entering it is an explicit, confirmed act; there is no switch back
 *                (only a verified official restore or install makes the Package official again);
 *   watcher    — runtime only; start/stop freely.
 * The installed work tree is the only source: nothing is copied, synced, or mounted.
 */
async function startPackageDev(item) {
  const state = item.install_safety?.state;
  if (state !== 'development') {
    const accepted = await confirmAction({
      title: tf('进入开发 · {name}', { name: packageAdminName(item) }),
      label: '进入开发',
      details: [
        ['Package ID', item.id],
        [tr('当前版本'), item.version],
        [tr('工作目录'), item.worktree ?? item.installed_dir ?? 'n/a'],
        [tr('之后'), tr('这个 Package 会保留为 Development 状态。不能用开关直接变回 Official；恢复正式版需要 Restore 或重新安装正式 Release。')],
        [tr('热重载'), tr('同时开始监视工作目录：保存即重新载入，Framework 更新在停止监视前不可用。')],
      ],
      acknowledgement: '我知道开发状态不会自动退出。',
    });
    if (!accepted) return;
    try {
      await apiData(`/api/dev/packages/${encodeURIComponent(item.id)}/development/activate`, { method: 'POST', body: '{}' });
    } catch (error) {
      const code = error?.data?.error_code ?? error?.data?.error ?? String(error?.message ?? error);
      packageNotice = { kind: 'bad', text: code === 'development_lineage_unavailable'
        ? tf('{name} 没有可验证的 Git 基线（不是带 Git 的 Release 安装的），不能原地开发。', { name: packageAdminName(item) })
        : tf('进入开发：{error}', { error: code }) };
      return loadPackageManager();
    }
  }
  try {
    await apiData('/api/dev/packages', { method: 'POST', body: JSON.stringify({ package_id: item.id }) });
    packageNotice = { kind: 'good', text: tf('{name} 开发中，正在监视 {dir}。直接在这个目录修改与提交。',
      { name: packageAdminName(item), dir: item.worktree ?? item.installed_dir }) };
  } catch (error) {
    packageNotice = { kind: 'bad', text: tf('开始监视：{error}', { error: error.message ?? error }) };
  }
  return loadPackageManager();
}

async function stopPackageDev(item) {
  try {
    await apiData(`/api/dev/packages/${encodeURIComponent(item.id)}/stop`, { method: 'POST', body: '{}' });
    packageNotice = { kind: 'good', text: tf('已停止监视 {id}。开发状态与工作目录不变。', { id: item.id }) };
  } catch (error) {
    packageNotice = { kind: 'bad', text: tf('停止监视：{error}', { error: error.message ?? error }) };
  }
  return loadPackageManager();
}

/** Plain-language local history for dialogs; no Git plumbing beyond counts. */
function localHistoryRows(item) {
  const s = item.install_safety ?? {};
  const branches = (s.local_refs ?? []).filter((ref) => String(ref.ref).startsWith('refs/heads/'));
  return [
    [tr('当前分支'), s.branch ?? (s.detached ? tr('游离 HEAD') : 'n/a')],
    [tr('本地提交'), tf('{count} 个', { count: s.commits_ahead ?? 0 })],
    [tr('有未发布提交的分支'), branches.length
      ? branches.map((b) => tf('{branch}（{count}）', { branch: String(b.ref).replace('refs/heads/', ''), count: b.commits ?? '?' })).join(tr('、'))
      : tr('无')],
    ['stash', tf('{count} 个', { count: s.stash_count ?? 0 })],
    [tr('未提交的修改'), tf('{count} 个文件', { count: s.worktree_changes ?? 0 })],
  ];
}

/**
 * Any operation that replaces or removes the work tree: when local history or Development is
 * present, ask which of two explicit outcomes to take; otherwise a plain confirmation.
 * `labels` are complete translatable phrases, never a verb glued into a sentence.
 */
async function protectedChoice(item, { title, verb, preserveLabel, forceLabel, details }) {
  if (!item.install_safety?.dirty) {
    const ok = await confirmAction({ title, label: verb, details });
    return ok ? {} : null;
  }
  const choice = await chooseAction({
    title,
    details: [...details, ...localHistoryRows(item)],
    note: '这里有只存在于本机的开发内容。备份会保存完整工作目录（含 .git、分支、stash），之后可以在「开发备份」里恢复。',
    choices: [
      { value: 'preserve', label: preserveLabel, variant: 'primary' },
      { value: 'force', label: forceLabel, variant: 'danger-text' },
    ],
  });
  if (choice === 'preserve') return { preserve_development: true };
  if (choice === 'force') return { force_discard: true };
  return null;
}

async function startLifecycleJob(item, action, body, doneText) {
  try {
    const response = await api(`/api/admin/package-manager/packages/${encodeURIComponent(item.id)}/${action}`, {
      method: 'POST', body: JSON.stringify({ confirm_package_id: item.id, ...body }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? result.error);
    packageNotice = { kind: 'good', text: tf('{done}：{job}。Framework 可能会重启，页面会重新连接并显示结果。', { done: tr(doneText), job: jobLabel(result.job) }) };
  } catch (error) {
    packageNotice = { kind: 'bad', text: String(error?.message ?? error) };
  }
  await loadPackageManager();
}

async function startRestoreOfficial(item) {
  const options = await protectedChoice(item, {
    title: tf('恢复正式版 · {name}', { name: packageAdminName(item) }),
    verb: tr('恢复'),
    preserveLabel: tr('备份开发内容后恢复'),
    forceLabel: tr('强制丢弃并恢复'),
    details: [
      ['Package ID', item.id],
      [tr('恢复到'), tf('{version} 的已验证 Release', { version: item.version })],
      [tr('配置 / 数据'), tr('保留')],
    ],
  });
  if (options) await startLifecycleJob(item, 'restore', options, '已开始恢复正式版');
}

async function startBackupRestore(item, backup) {
  const options = await protectedChoice(item, {
    title: tf('从开发备份恢复 · {name}', { name: packageAdminName(item) }),
    verb: tr('恢复'),
    preserveLabel: tr('备份开发内容后恢复'),
    forceLabel: tr('强制丢弃并恢复'),
    details: [
      [tr('备份'), backup.name],
      [tr('创建于'), backup.created_at],
      [tr('分支 / HEAD'), `${backup.branch ?? tr('游离')} @ ${String(backup.head ?? '').slice(0, 7)}`],
      ['stash', tf('{count} 个', { count: backup.stash_count ?? 0 })],
    ],
  });
  if (options) await startLifecycleJob(item, 'restore-backup', { ...options, backup: backup.name }, '已开始从备份恢复');
}

/** The Development panel: state, work tree, restore, and backups (loaded when opened). */
function developmentPanel(item) {
  const s = item.install_safety ?? {};
  const panel = document.createElement('details'); panel.className = 'inline-details development-panel';
  panel.dataset.state = s.state ?? 'unknown';
  panel.append(Object.assign(document.createElement('summary'), {
    textContent: tf('开发与恢复 · 开发备份：{count}', { count: item.development_backups ?? 0 }),
  }));
  const body = document.createElement('div'); body.className = 'development-body';
  body.append(valueRow('状态', stateLabel(s.state)), valueRow('工作目录', item.worktree ?? item.installed_dir ?? 'n/a'));
  if (item.development_only) body.append(text('p', '这个 Package 从未发布过正式 Release：没有可恢复的正式版。', 'note'));
  const row = document.createElement('div'); row.className = 'button-row';
  row.append(actionButton('恢复正式版', '', () => startRestoreOfficial(item),
    !canWrite() || !item.restorable || s.state === 'official'));
  body.append(row);
  const list = document.createElement('div'); list.className = 'development-backups';
  body.append(text('b', '开发备份'), list);
  panel.append(body);
  panel.addEventListener('toggle', async () => {
    if (!panel.open || list.dataset.loaded) return;
    list.dataset.loaded = '1';
    try {
      const data = await apiData(`/api/dev/packages/${encodeURIComponent(item.id)}/development/backups`);
      const backups = data.backups ?? [];
      if (!backups.length) { list.append(text('p', '还没有开发备份。', 'empty')); return; }
      for (const backup of backups) {
        const entry = document.createElement('div'); entry.className = 'development-backup';
        entry.append(text('small', `${backup.created_at} · ${backup.version} · ${backup.branch ?? tr('游离')} @ ${String(backup.head ?? '').slice(0, 7)} · ${tr(BACKUP_REASONS[backup.reason] ?? backup.reason)} · stash ${backup.stash_count ?? 0}`));
        entry.append(actionButton('恢复', '', () => startBackupRestore(item, backup),
          !canWrite() || backup.version !== item.version));
        list.append(entry);
      }
    } catch (error) { list.append(text('p', tf('读取开发备份：{error}', { error: error.message ?? error }), 'alert error')); }
  });
  return panel;
}

// Protocol nouns stay as they are in every language (Official / Development / …).
const STATE_LABELS = { official: 'Official', development: 'Development', modified: 'Modified', unknown: 'Unknown', conflicted: 'Conflict' };
const stateLabel = (state) => STATE_LABELS[state] ?? 'Unknown';
const BACKUP_REASONS = { manual: '手动备份', update: '安装前', restore: '恢复正式版前', uninstall: '卸载前', prune: '清理旧版本前', 'before-backup-restore': '从备份恢复前' };

/** One short line: what the work tree holds right now, for development and modified Packages. */
function developmentSummary(item) {
  const s = item.install_safety ?? {};
  if (!['development', 'modified'].includes(s.state)) return null;
  const parts = [s.state === 'development' ? tr('开发中') : tr('已修改（未进入开发）')];
  if (s.head) parts.push(`${s.branch ?? tr('游离 HEAD')} / HEAD ${String(s.head).slice(0, 7)}`);
  const branches = (s.local_refs ?? []).filter((ref) => String(ref.ref).startsWith('refs/heads/')).length;
  const counts = [];
  if (s.commits_ahead) counts.push(tf('{count} 个本地提交', { count: s.commits_ahead }));
  if (branches) counts.push(tf('{count} 个分支有未发布提交', { count: branches }));
  if (s.stash_count) counts.push(tf('{count} 个 stash', { count: s.stash_count }));
  if (s.worktree_changes) counts.push(tf('{count} 个未提交文件', { count: s.worktree_changes }));
  parts.push(counts.length ? counts.join(' · ') : tr('尚未修改'));
  return parts.join(' · ');
}

async function startInstalledAction(item, action) {
  const rollback = action === 'rollback';
  if (!rollback && item.install_safety?.dirty) {
    const options = await protectedChoice(item, {
      title: tf('卸载 {name}', { name: packageAdminName(item) }),
      verb: tr('卸载'),
      preserveLabel: tr('备份开发内容后卸载'),
      forceLabel: tr('强制丢弃并卸载'),
      details: [['Package ID', item.id], [tr('当前版本'), item.version], [tr('配置'), tr('保留（重新安装时可继续使用）')]],
    });
    if (options) await startLifecycleJob(item, 'uninstall', options, '已开始卸载');
    return;
  }
  const accepted = await confirmAction({
    title: rollback ? tf('回滚 {name}', { name: packageAdminName(item) }) : tf('卸载 {name}', { name: packageAdminName(item) }),
    label: rollback ? tr('回滚') : tr('卸载'),
    details: [
      ['Package ID', item.id],
      [tr('当前版本'), item.version],
      rollback ? [tr('回滚到'), item.previous_version] : [tr('已安装的代码'), tr('将被移除')],
      [tr('会停止的服务'), item.services.length ? item.services.join(', ') : tr('无')],
      [tr('配置 / 数据'), tr('保留')],
      [tr('提供者绑定 / 期望状态'), tr('保留')],
      [tr('失败时的行为'), rollback ? tr('Package Manager 的事后检查会报告失败') : tr('结果保留在任务记录中')],
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
    packageNotice = { kind: 'good', text: tf('已开始 {job}。Framework 可能会重启，页面会重新连接并显示结果。', { job: jobLabel(result.job) }) };
  } catch (error) {
    packageNotice = { kind: 'bad', text: String(error?.message ?? error) };
  }
  await loadPackageManager();
}


/**
 * 依賴計畫 → 確認對話框的明細行。
 *
 * ⭐ 每一項都說出**它卡在哪一級**，而不是一個 ready/not ready 的布林：
 * `missing` 要去下載，`installed` 是裝了沒配，`healthy` 多半是版本不夠——
 * 三者要做的事完全不同，壓成一個布林使用者就不知道該去修哪個。
 *
 * ⚠ 只報下載量，不報「所需磁盘空间」：解壓後多大沒有任何一方聲明過，
 * 編一个数字出來比不報更糟。
 */
const DEP_KIND_LABEL = { package: 'Package', capability: 'Adapter', asset: 'Asset' };
const DEP_STATE_LABEL = {
  missing: '缺失', installed: '已装未配置', configured: '已配置未连通',
  reachable: '连通但不健康', healthy: '版本不满足', compatible: '机型不匹配', ready: '就绪',
};
const bytesLabel = (n) => {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(0)} KB`;
};

function dependencyRows(plan) {
  if (!plan?.nodes?.length) return [];
  const rows = [['依赖', `${plan.nodes.length} 项 · ${plan.installable ? '可安装' : '不可安装'}`]];
  const willInstall = new Set(plan.install_order ?? []);
  for (const node of plan.nodes) {
    const kind = DEP_KIND_LABEL[node.kind] ?? node.kind;
    const need = node.required ? '必需' : '可选';
    const parts = [DEP_STATE_LABEL[node.state] ?? node.state, ...dependencyDetail(node, plan, willInstall)];
    rows.push([`${kind} · ${need}`, `${node.id} — ${parts.join(' · ')}`]);
  }
  if (plan.install_order?.length) rows.push(['安装顺序', plan.install_order.join(' → ')]);
  const total = bytesLabel(plan.download_bytes);
  if (total) rows.push(['需要下载', total]);
  return rows;
}

/**
 * 一行依赖要说清的只有两件事：它现在是什么状态，这次安装会不会动它。
 *
 * ⚠ 「会不会动它」只看 `install_order`——那是安装路径真正执行的清单。Capability 的
 * 提供方挂在 `node.providers` 上而不是 `node.download`；只看后者会把一个马上就要
 * 随安装补上的 Adapter 报成「Catalog 里没有」，与同一张表里的安装顺序自相矛盾。
 */
function dependencyDetail(node, plan, willInstall) {
  const parts = [];
  if (node.installed_version) parts.push(`已装 ${node.installed_version}`);
  if (node.version) parts.push(`要求 ${node.version}`);
  if (node.state === 'ready') return parts;
  const source = node.download ?? (node.providers?.length === 1 ? node.providers[0] : null);
  if (source && willInstall.has(source.package_id)) {
    parts.push(node.download ? `将安装 ${source.version}` : `将安装提供方 ${source.package_id} ${source.version}`);
    const size = bytesLabel(source.size);
    if (size) parts.push(size);
    // 来源与校验状态：装的东西从哪来、有没有可比对的哈希，是同一个问题的两半。
    if (source.repository) parts.push(source.repository);
    parts.push(source.sha256 ? 'SHA-256 已登记' : '⚠ 无 SHA-256');
    return parts;
  }
  if (node.needs_choice) {
    parts.push(`有多个提供方（${node.providers.map((p) => p.package_id).join('、')}），请先手动安装其一`);
    return parts;
  }
  if (!node.required) {
    if (node.state !== 'missing') parts.push('当前不可用，不影响安装');
    else parts.push(source ? `不自动安装，可另行安装 ${source.package_id}` : '不自动安装，缺少时相关功能不可用');
    return parts;
  }
  if (node.state !== 'missing') parts.push('⚠ 已安装但尚未就绪');
  else if (plan.dependency_mode === 'local_only') parts.push('⚠ 本机未就绪');
  else parts.push(node.kind === 'package' ? '⚠ Catalog 里没有' : '⚠ 没有已知的提供方');
  return parts;
}

async function installUpload(upload) {
  const identity = upload.identity ?? {};
  installDialogReset(`安装 ${identity.name ?? identity.id ?? upload.original_name}`, ['检查', '安装', '完成']);
  return runGuidedInstallFromUpload(upload, identity.name ?? identity.id ?? upload.original_name, { stepOffset: 0 });
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
  const stateTag = text('span', stateLabel(item.install_safety?.state), `package-tag package-state state-${item.install_safety?.state ?? 'unknown'}`);
  stateTag.dataset.state = item.install_safety?.state ?? 'unknown';
  tags.append(stateTag, text('span', item.version, 'package-tag'), text('span', item.target ?? 'generic', 'package-tag'));
  for (const type of item.types ?? []) tags.append(text('span', type, 'package-tag'));
  card.append(tags);
  const devLine = developmentSummary(item);
  if (devLine) card.append(text('p', devLine, 'package-development-summary'));
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
    () => startPackageUpgrade(item), !canWrite() || !upgrade));
  // Watcher only: there is no "leave Development" switch; that is a restore (see the panel below).
  actions.append(item.dev_watching
    ? actionButton('停止监视', 'primary', () => stopPackageDev(item), !canWrite())
    : actionButton(item.install_safety?.state === 'development' ? '开始监视' : '开发', '',
      () => startPackageDev(item), !canWrite() || !item.installed_dir));
  actions.append(actionButton('回滚', '',
    () => startInstalledAction(item, 'rollback'), !canWrite() || !item.previous_version));
  actions.append(actionButton('卸载', 'danger-text',
    () => startInstalledAction(item, 'uninstall'), !canWrite()));
  card.append(actions);
  const details = document.createElement('details'); details.className = 'inline-details';
  details.append(Object.assign(document.createElement('summary'), { textContent: '版本详情' }),
    text('small', `SHA ${item.archive_sha256 ?? (item.development_only ? '尚无正式 Release' : 'n/a')} · installed ${item.installed_at ?? 'n/a'}`));
  card.append(details);
  card.append(developmentPanel(item));
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

/**
 * ⭐ 資產不在這兩頁裡。
 *
 * 一個 asset 是別的 Package 的模型權重——它由需要它的那個 Package 帶進來，也該在
 * 那個 Package 自己的頁面上下載與刪除。列在這裡只會讓人以為它是一個可以獨立
 * 管理的東西，然後面對一堆自己既沒選過也不知道能不能刪的條目。
 */
/**
 * 目录里的版本相对已装版本是什么关系。⚠ 按段比较数字，不是字符串——
 * `0.2.7` 的字符串序排在 `0.2.10` 前面，而那正是这套目录踩过的坑。
 */
function compareVersionStrings(offered, installed) {
  const parts = (value) => String(value).split('.').map((n) => Number(n) || 0);
  const [a, b] = [parts(offered), parts(installed)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return 'newer';
    if (left < right) return 'older';
  }
  return 'same';
}

const isAssetPackage = (item) => (item.types ?? []).includes('asset')
  || String(item.id ?? '').includes('.asset.');

function renderInstalledPackages(data) {
  const wrap = document.createElement('div');
  if (data.broken?.length) wrap.append(text('div', `${data.broken.length} Installed Root record(s) need review. See Recent operations for the exact failure.`, 'alert error'));
  const visible = (data.packages ?? []).filter((item) => !isAssetPackage(item));
  const packages = visible.filter(packageMatches);
  if (!visible.length) wrap.append(text('p', '还没有安装任何 Package，可以从下面的文件安装。', 'empty'));
  else if (!packages.length) wrap.append(text('p', '没有符合当前搜索或筛选的 Package。', 'empty'));
  else {
    const grid = document.createElement('div'); grid.className = 'package-grid';
    grid.append(...packages.map(renderPackageCard)); wrap.append(grid);
  }
  // 「待安装」整块移除：下载、检查、安装现在是一条引导流程走完的，中间不再有一个
  // 需要用户自己回来处理的中间态。留着它只会让人以为还有一步要做。
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

let registryByRepository = new Map();

/**
 * Installed 版本与 Core 给出的已验证更新候选。
 *
 * WebUI 只消费 `registry_update.selection`，不再自行查目录、比较版本或筛选
 * source_tar。这样 release_asset 与 source_tar 的选择永远由 Framework Core 统一决定。
 */
function packageUpgrade(item) {
  const update = item.registry_update;
  if (!update?.update_available || !update.selection?.version) return null;
  return update.selection.version;
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
  /**
   * ⭐ 索引里**已经**有 provides/depends，先前这里一条都不看。
   *
   * 于是一个声明了 5 项能力、11 条依赖的包被写成「未申報任何公開資訊」——那句话
   * 读起来像上游偷懒，实际是我们拿着答案没打开。⚠ 两处 schema 不同不是不显示的理由：
   * `public_metadata` 是包自己写的散文，索引是从**归档本身**抽出来的事实，后者更该信。
   */
  const indexed = (details.packages ?? []).flatMap((entry) => entry.provides ?? []);
  const needs = (details.packages ?? []).flatMap((entry) => entry.depends ?? []);
  const byKind = (list, kind) => list.filter((n) => n.kind === kind).map((n) => n.id);
  appendSection('Provides capabilities', byKind(indexed, 'capability'));
  appendSection('Provides assets', byKind(indexed, 'asset'));
  appendSection('Requires packages', needs.filter((n) => n.kind === 'package')
    .map((n) => `${n.id}${n.version ? ` ${n.version}` : ''}${n.required === false ? '（可选）' : ''}`));
  appendSection('Requires capabilities', byKind(needs, 'capability'));
  appendSection('Requires assets', needs.filter((n) => n.kind === 'asset')
    .map((n) => `${n.id}${n.required === false ? '（可选）' : ''}`));
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
  /**
   * ⭐ 这一页回答的是「**我要装点什么**」，所以只列使用者会自己去装的三种。
   *
   * Framework 有它自己的更新流程（System → Framework Update），混在这里只会让人
   * 以为可以像装包一样装它。
   *
   * asset 则是另一回事：模型资产由**需要它的那个包**作为依赖带进来，没有人会先想
   * 「我今天想装个 SenseVoice 权重」。而目录里那几个 asset 条目里，有一半连
   * `source_tar` 都没有——它们存在的唯一理由是让下载代理认得上游那几个文件的坐标，
   * 从来就不是可安装的东西。把它们排在这里，一半是装不了的假入口，另一半是
   * 「装了也没用，除非你已经装了要用它的那个包」。
   *
   * ⚠ 这只是**这一页的取景**，不是能力上的限制：依赖解析走的是服务端的
   * `packageRegistryFindByPackageId`，asset 照样会被自动装上。
   */
  const BROWSABLE_TYPES = new Set(['adapter', 'app', 'service']);
  const installable = registry.packages.filter(
    (item) => item.types?.some((type) => BROWSABLE_TYPES.has(type)));
  if (!installable.length) {
    wrap.append(text('p', 'Registry 没有返回可安装的 Package。', 'empty'));
    return wrap;
  }
  // 已安装的那些：卡片上的按钮该说「已安装」，而不是给一个按下去只会重来一遍的「安装」。
  const installedVersions = new Map((data.packages ?? []).map((p) => [p.id, p.version]));
  for (const item of installable) {
    const card = document.createElement('article'); card.className = 'panel package-card registry-card';
    const version = item.versions?.find((entry) => entry.version === (item.latest_verified_version ?? item.latest_version)) ?? item.versions?.[0];
    // Archive kind, filename and source are selected by Core and carried by the catalog snapshot.
    const selection = version?.selection ?? null;
    const file = selection ? { ...selection, size: version.size, sha256: version.sha256 } : null;
    card.append(text('b', registryDisplayName(item)), text('small', item.repository, 'meta'));
    if (item.description) card.append(text('p', item.description, 'package-card-description'));
    card.append(valueRow('最新已验证', version?.version ?? item.latest_verified_version ?? 'n/a'),
      valueRow('发布时间', item.latest_verified_published_at ?? version?.published_at ?? 'n/a'));
    if (file) {
      card.append(valueRow('源码包', formatBytes(file.size)));
      const detailBox = document.createElement('div'); detailBox.className = 'registry-details'; detailBox.hidden = true;
      let publicDetailsLoaded = false;
      /**
       * ⚠ 按钮要按**版本**说话，不是按「这个 id 装过没有」。
       *
       * 先前它只看装没装：于是装了 0.18.0 之后，0.19.0 的卡片上写着「最新已验证 0.19.0」，
       * 按钮却是灰的「已安装 0.18.0」——**升级这条路整个消失了**，而卡片上每一个字都是对的。
       * 一个只回答「装过吗」的控件，答不了「该不该按」。
       *
       * 三种关系三句话，与 Framework 更新页同一套词：同版本没事可做，新版本是更新，
       * 旧版本是降级（明说方向，因为它可能读不懂当前配置）。
       */
      const installedVersion = item.package_id ? installedVersions.get(item.package_id) : undefined;
      const relation = installedVersion === undefined ? 'new'
        : compareVersionStrings(version.version, installedVersion);
      const label = { new: '安装', newer: `更新到 ${version.version}`, older: `降级到 ${version.version}` }[relation]
        ?? `已安装 ${installedVersion}`;
      const download = relation === 'same'
        ? actionButton(`已安装 ${installedVersion}`, 'ghost', () => {}, true)
        : actionButton(label, 'primary',
          () => runGuidedPackageInstall({ selection, name: item.display_name ?? item.repository, version: version.version }),
          !canWrite() || Boolean(data.active_job));
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
  // 上传之后同样走引导：检查、报告、同意、安装、重启，一次走完。
  // 先前上传完只留一句「已开始检查」，用户还要自己回到列表里找那张卡片。
  const upload = actionButton('安装', 'primary', async () => {
    const file = input.files?.[0];
    if (!file) {
      packageNotice = { kind: 'bad', text: '请先选择一个 .tar.gz 安装包。' };
      return loadPackageManager();
    }
    upload.disabled = true; progress.hidden = false;
    installDialogReset(`安装 ${file.name}`, ['上传', '检查', '安装', '完成']);
    installStep(0, 'active');
    let stored;
    try {
      const response = await api('/api/admin/package-manager/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail ?? result.error);
      stored = result.upload;
    } catch (error) {
      installStep(0, 'failed');
      installFail(String(error?.message ?? error));
      upload.disabled = false; progress.hidden = true;
      return loadPackageManager();
    }
    upload.disabled = false; progress.hidden = true;
    return runGuidedInstallFromUpload(stored, file.name);
  });
  const controls = document.createElement('div');
  controls.className = 'upload-row';
  controls.append(input, upload, progress);
  wrap.append(controls);
  // 上传历史不在这里：装完就没有中间态了，而失败的记录在 Status / Logs。
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
  const configurable = (data.packages ?? []).filter((item) => !isAssetPackage(item));
  if (!configurable.length) panel.body.append(text('p', '没有可配置的已安装 Package。', 'empty'));
  else {
    const grid = document.createElement('div'); grid.className = 'package-setting-grid';
    grid.append(...configurable.map((item) => renderPackageSettingCard(item, data.policy)));
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
