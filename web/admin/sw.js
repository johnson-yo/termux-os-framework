/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Navigation and static asset requests under /admin/.
 * [OUTPUT]: A cached application shell so the installed control panel opens without a round trip.
 * [POS]: web/admin/sw.js in termux-os-framework. Registered by the administration HTML.
 *
 *        Only the shell is cached, never an API response. A control panel showing yesterday's
 *        service states is worse than one that says it cannot reach the Framework, because the user
 *        acts on what it shows. Every /api/ request therefore goes to the network, always.
 *
 *        Nothing is cached that is not the thing that was asked for. The first version of this
 *        worker pre-cached the shell on install, which happens on the login page, where every
 *        script URL redirects to that same login page: the worker stored the login HTML under
 *        /admin/app.js, and after signing in the browser was handed HTML where it expected
 *        JavaScript and the panel never started. Clearing the browser cache did not help, because
 *        this store is separate and the next install poisoned it again. So there is no pre-cache,
 *        a redirected response is never stored, and a stored entry whose type does not match the
 *        request is discarded rather than served.
 *
 *        The cache name carries the Framework version, which the page passes in at registration.
 *        A new version registers a different script URL, so the browser installs the new worker,
 *        and activation drops every cache belonging to another version. That is also what stops an
 *        updated device from running the previous release's JavaScript against the new API.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `termux-os-admin-${VERSION}`;

// Each shell asset and the content type it must have. A response that is not this is not the asset.
const SHELL = new Map([
  ['/admin/style.css', 'text/css'],
  ['/admin/session.js', 'javascript'],
  ['/admin/app-core.js', 'javascript'],
  ['/admin/admin-controls.js', 'javascript'],
  ['/admin/app.js', 'javascript'],
  ['/admin/icon.svg', 'image/svg'],
]);

self.addEventListener('install', (event) => {
  // 不預先抓取。安裝發生在登入頁上，那裡每一個 shell 位址都會被導回登入頁本身。
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names
      .filter((name) => name.startsWith('termux-os-admin-') && name !== CACHE)
      .map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

/** A response is the asset only if it came back un-redirected, ok, and as the right type. */
const usable = (response, expectedType) => Boolean(response)
  && response.ok
  && response.type === 'basic'
  && !response.redirected
  && (response.headers.get('content-type') || '').includes(expectedType);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 控制面的資料一律走網路。過期的狀態會被當成現況，比擺明連不上更糟。
  if (url.pathname.startsWith('/api/')) return;

  // 導覽請求先試網路：Framework 沒在跑時才退回快取的殼，讓使用者至少看得到頁面而不是瀏覽器錯誤。
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(request).then((hit) => hit ?? Response.error())));
    return;
  }

  const expected = SHELL.get(url.pathname);
  if (!expected) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    // 型別對不上的快取條目一律丟棄：那代表存進去的不是這個資源，繼續用只會壞得更難查。
    if (hit && (hit.headers.get('content-type') || '').includes(expected)) return hit;
    if (hit) await cache.delete(request);
    const response = await fetch(request);
    if (usable(response, expected)) cache.put(request, response.clone()).catch(() => {});
    return response;
  })());
});
