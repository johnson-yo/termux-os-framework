/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/adapter-http/web/app.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const pathPackageId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const ACTIVE_PACKAGE_ID = /^[\w.@-]+$/.test(pathPackageId)
  ? pathPackageId : 'github.termux-os.adapter.example-http';
const PKG = '/api/packages/' + ACTIVE_PACKAGE_ID;
const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => window.TermuxOS.api(path, opts);

async function loadStatus() {
  try {
    const response = await api(PKG + '/config');
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? result.error ?? `HTTP ${response.status}`);
    $('status').textContent = JSON.stringify(result, null, 2);
    if (!$('endpoint').value) $('endpoint').value = result.config?.endpoint ?? '';
    $('note').textContent = '';
  } catch (e) { $('note').textContent = String(e); }
}

async function saveProvider() {
  const body = { endpoint: $('endpoint').value.trim() };
  if ($('token').value) body.credential = $('token').value;
  const response = await api(PKG + '/config', { method: 'POST', body: JSON.stringify(body) });
  const result = await response.json();
  $('token').value = '';
  if (!response.ok) throw new Error(result.detail ?? result.error ?? `HTTP ${response.status}`);
  await loadStatus();
}

window.TermuxOS.ready.then(() => {
  $('save').addEventListener('click', () =>
    saveProvider().catch((e) => { $('note').textContent = String(e); }));
  loadStatus();
  setInterval(loadStatus, 2000);
});
