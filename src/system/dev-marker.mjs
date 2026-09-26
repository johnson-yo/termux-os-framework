/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A validated Package ID, the current Dev Runtime sequence, and the watcher session.
 * [OUTPUT]: A Framework-owned, non-interactive Dev viewport marker and reload watcher.
 * [POS]: src/system/dev-marker.mjs in termux-os-framework. The marker is injected by Core,
 *        so an Extension Package never needs release-visible Dev CSS or banner logic.
 * [PROTOCOL]: Keep the fixed overlay non-layout, non-interactive, and absent from release HTML.
 *             An open dev page must survive `dev stop` (slow poll, no reload) and follow the next
 *             `dev start`; only pages served while watching carry the script.
 */

const marker = () => '<div data-termux-os-dev-marker="1" aria-hidden="true" '
  + 'style="position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;'
  + 'border:2px solid rgba(245,158,11,.9);box-shadow:inset 0 0 10px rgba(245,158,11,.28);'
  + 'pointer-events:none"></div>';

/**
 * The script that keeps an open dev page current.
 *
 * It reloads when the watcher session changes (a new `dev start`), when `seq` advances (a
 * change batch landed), or when the Package is no longer loaded. While the Package is not
 * watched it keeps a slow poll instead of reloading: reloading then would fetch a page without
 * this script, and a page opened in a dev session could never follow the next `dev start`.
 */
export function devInjection(pkgId, seq, session = null) {
  return `${marker()}
<script>(function(){var last=${Number(seq) || 0},session=${JSON.stringify(session ?? null)},delay=1500;
function tick(){fetch('/api/dev/packages/${pkgId}/events',{cache:'no-store'}).then(function(r){return r.json();})
.then(function(d){if(!d||!d.ok||d.watching===false){delay=5000;return;}delay=1500;
if(d.session!==session||d.seq!==last||d.status!=='loaded')location.reload();})
.catch(function(){delay=5000;}).then(function(){setTimeout(tick,delay);});}
setTimeout(tick,delay);})();</script>`;
}

export function devMarkerHtml() {
  return marker();
}

if (process.argv.includes('--self-test')) {
  const html = devInjection('org.example.service.demo', 3, 'abc123');
  const style = html.match(/style="([^"]+)"/)?.[1] ?? '';
  if (!html.includes('data-termux-os-dev-marker="1"')
    || !style.includes('position:fixed')
    || !style.includes('inset:0')
    || !style.includes('pointer-events:none')
    || !style.includes('border:2px solid')
    || html.includes('DEV WORKSPACE')
    || !html.includes('"abc123"')
    || !html.includes("d.watching===false")) {
    throw new Error('Framework Dev marker contract failed');
  }
  console.log('PASS Dev marker contract');
}
