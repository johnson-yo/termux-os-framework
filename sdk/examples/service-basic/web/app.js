/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/examples/service-basic/web/app.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const PKG = '/api/packages/github.termux-os.service.example-counter';
const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => window.TermuxOS.api(path, opts);

async function loadStatus() {
  try {
    const response = await api(PKG + '/status');
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail ?? result.error ?? `HTTP ${response.status}`);
    $('status').textContent = JSON.stringify(result, null, 2);
    $('note').textContent = '';
  } catch (e) { $('note').textContent = String(e); }
}
window.TermuxOS.ready.then(() => {
  loadStatus();
  setInterval(loadStatus, 2000);
});
