/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: web/admin/login.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

// 语言在这里也要生效：登录页与 Setup 页是使用者看到的第一屏。
window.TermuxOSI18n?.load?.(window.__TERMUX_OS_LANGUAGE__);

const form = document.getElementById('login-form');
const button = document.getElementById('login-button');
const error = document.getElementById('login-error');

const safeNext = () => {
  const value = new URLSearchParams(location.search).get('next') ?? '';
  return value.startsWith('/admin/') || value.startsWith('/packages/')
    ? value
    : '/admin/status/overview';
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    const result = await response.json();
    if (!response.ok) {
      error.textContent = result.error === 'too_many_attempts'
        ? '尝试次数过多，请等一分钟再试。'
        : '管理员密码不正确。';
      error.hidden = false;
      return;
    }
    location.replace(safeNext());
  } catch {
    error.textContent = '连不上 Framework，请检查连接后重试。';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
