/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A validated Package ID and the current Dev Runtime sequence.
 * [OUTPUT]: A Framework-owned, non-interactive Dev viewport marker and reload watcher.
 * [POS]: src/system/dev-marker.mjs in termux-os-framework. The marker is injected by Core,
 *        so an Extension Package never needs release-visible Dev CSS or banner logic.
 * [PROTOCOL]: Keep the fixed overlay non-layout, non-interactive, and absent from release HTML.
 */

const marker = () => '<div data-termux-os-dev-marker="1" aria-hidden="true" '
  + 'style="position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;'
  + 'border:2px solid rgba(245,158,11,.9);box-shadow:inset 0 0 10px rgba(245,158,11,.28);'
  + 'pointer-events:none"></div>';

export function devInjection(pkgId, seq) {
  return `${marker()}
<script>(function(){var last=${Number(seq) || 0};setInterval(function(){
  fetch('/api/dev/packages/${pkgId}/events').then(function(r){return r.json();}).then(function(d){
    if(d.seq!==last||d.status!=='loaded')location.reload();
  }).catch(function(){});},1500);})();</script>`;
}

export function devMarkerHtml() {
  return marker();
}

if (process.argv.includes('--self-test')) {
  const html = devInjection('org.example.service.demo', 3);
  const style = html.match(/style="([^"]+)"/)?.[1] ?? '';
  if (!html.includes('data-termux-os-dev-marker="1"')
    || !style.includes('position:fixed')
    || !style.includes('inset:0')
    || !style.includes('pointer-events:none')
    || !style.includes('border:2px solid')
    || html.includes('DEV WORKSPACE')) {
    throw new Error('Framework Dev marker contract failed');
  }
  console.log('PASS Dev marker contract');
}
