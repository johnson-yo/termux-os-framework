/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: web/admin/login.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

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
        ? 'Too many attempts. Wait one minute and try again.'
        : 'The administrator password is not correct.';
      error.hidden = false;
      return;
    }
    location.replace(safeNext());
  } catch {
    error.textContent = 'Framework is not reachable. Check the connection and try again.';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
