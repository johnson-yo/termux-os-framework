/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: GET /api/admin/setup for the generated credentials and what the migration did.
 * [OUTPUT]: The credentials on screen once, an optional password of the user's own, and the decision
 *           whether to keep the previous version's settings.
 * [POS]: web/admin/setup.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

// 语言在这里也要生效：登录页与 Setup 页是使用者看到的第一屏。
window.TermuxOSI18n?.load?.(window.__TERMUX_OS_LANGUAGE__);

const el = (id) => document.getElementById(id);
const card = el('setup-card');
const error = el('setup-error');
let setupToken = null;
const state = { minimum: 16 };

const fail = (message) => { error.textContent = message; error.hidden = false; };

/** Names as the user sees them, so a review does not read like a diff of internal key paths. */
const listOf = (paths) => paths.map((p) => `<code>${p}</code>`).join('、');

function renderMigration(step, migration) {
  const block = el('config-block');
  const summary = el('config-summary');
  const check = el('use-previous');
  const label = el('use-previous-label');

  if (!migration) { block.hidden = true; return; }

  if (step === 'review') {
    label.textContent = '继续使用这些设置';
    el('setup-title').textContent = '更新完成';
    el('setup-lead').textContent = '这一版新增了一些设置。下面是它对你原有配置做的事。';
  }

  if (!migration.has_previous) {
    // 全新安装没有可继承的东西，摆一个能勾的框只会让人以为漏掉了什么。
    check.checked = false;
    check.disabled = true;
    summary.textContent = '这台设备上没有更早的配置，全部使用本版默认值。';
    return;
  }

  const parts = [];
  if (migration.transplanted.length) parts.push(`沿用了 ${migration.transplanted.length} 项你设过的值`);
  if (migration.defaulted.length) parts.push(`${migration.defaulted.length} 项本版新增的设置使用默认值`);
  if (migration.coerced.length) parts.push(`${migration.coerced.length} 项旧值本版读不了，已改回默认`);
  if (migration.kept.length) parts.push(`${migration.kept.length} 项本版不再使用的设置原样保留`);
  summary.textContent = `${parts.join('，')}。取消勾选则全部使用本版默认值。`;

  const detail = el('config-detail');
  const body = el('config-detail-body');
  const sections = [];
  if (migration.transplanted.length) sections.push(`<p><b>沿用</b>：${listOf(migration.transplanted)}</p>`);
  if (migration.defaulted.length) sections.push(`<p><b>新增（用默认值）</b>：${listOf(migration.defaulted)}</p>`);
  if (migration.coerced.length) {
    sections.push(`<p><b>读不了，已改回默认</b>：${migration.coerced
      .map((item) => `<code>${item.path}</code>（需要 ${item.expected}，存的是 ${item.found}）`).join('、')}</p>`);
  }
  if (migration.kept.length) sections.push(`<p><b>本版不再使用，已保留</b>：${listOf(migration.kept)}</p>`);
  body.innerHTML = sections.join('');
  detail.hidden = sections.length === 0;
}

async function load() {
  try {
    const response = await fetch('/api/admin/setup', { headers: { Accept: 'application/json' } });
    if (!response.ok) { location.replace('/admin'); return; }
    const data = await response.json();
    setupToken = data.setup_token;
    // 最小長度由後端給，寫死在這裡遲早跟真正的規則對不上。
    state.minimum = data.password_minimum_length ?? 16;
    el('new-password').placeholder = `至少 ${state.minimum} 个字符`;
    el('setup-password').textContent = data.admin_password;
    el('setup-token').textContent = data.system_key;
    if (!data.editable) {
      // 憑證由環境或設定檔管理時，這裡改不了密碼，說清楚比讓輸入框無效地存在好。
      el('new-password').disabled = true;
      el('new-password').placeholder = '凭证由外部配置管理，无法在此修改';
    }
    renderMigration(data.step, data.migration);
    el('setup-lead').textContent = el('setup-lead').textContent === '正在读取本机凭证…'
      ? '这台设备已经可以直接使用，下面是它的管理凭证。'
      : el('setup-lead').textContent;
    el('setup-body').hidden = false;
    card.setAttribute('aria-busy', 'false');
  } catch {
    fail('读不到 Framework。请确认它还在运行。');
  }
}

document.addEventListener('click', async (event) => {
  const copyTarget = event.target.closest('[data-copy]');
  if (copyTarget) {
    const text = el(copyTarget.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      copyTarget.textContent = '已复制';
      setTimeout(() => { copyTarget.textContent = '复制'; }, 1500);
    } catch {
      // 剪貼簿在非安全上下文會被拒。密碼本來就顯示在畫面上，選取它仍然可行。
      copyTarget.textContent = '请手动选取';
    }
    return;
  }

  if (event.target.id !== 'setup-done') return;
  const button = event.target;
  button.disabled = true;
  error.hidden = true;
  const password = el('new-password').value;
  try {
    const response = await fetch('/api/admin/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup_token: setupToken,
        password: password || undefined,
        use_previous_config: el('use-previous').disabled ? true : el('use-previous').checked,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      fail(result.error === 'login_password_too_short'
        ? `密码太短了，至少 ${state.minimum} 个字符。`
        : `没能保存：${result.detail ?? result.error}`);
      button.disabled = false;
      return;
    }
    if (result.restart_required) {
      // 綁定位址這類設定要重啟才生效。與其假裝已經生效，不如把狀態說明白。
      el('setup-body').hidden = true;
      el('setup-lead').textContent = '设置已保存。配置有变动，请重启 Framework 后再进入控制台。';
      card.setAttribute('aria-busy', 'false');
      return;
    }
    // 回 /admin：本機會就地取得 Session 直接進去，別的來源才會看到登入頁。
    location.replace('/admin');
  } catch {
    fail('保存失败，Framework 没有响应。');
    button.disabled = false;
  }
});

load();
