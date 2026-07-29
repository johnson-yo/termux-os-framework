/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Navigation and static asset requests under /admin/.
 * [OUTPUT]: A cached application shell so the installed control panel opens without a round trip.
 * [POS]: web/admin/sw.js in termux-os-framework. Registered by app-core.js and setup.js.
 *
 *        Only the shell is cached, never an API response. A control panel that shows yesterday's
 *        service states is worse than one that says it cannot reach the Framework, because the user
 *        acts on what it shows. Every /api/ request therefore goes to the network, always.
 *
 *        The cache name carries the Framework version, which the page passes in at registration.
 *        Without that, a shell cached before an update would keep being served afterwards and the
 *        panel would silently run the previous release's JavaScript against the new API.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `termux-os-admin-${VERSION}`;
const SHELL = [
  '/admin/style.css',
  '/admin/session.js',
  '/admin/app-core.js',
  '/admin/admin-controls.js',
  '/admin/app.js',
];

self.addEventListener('install', (event) => {
  // 缺一個檔案不該讓整個安裝失敗——沒被快取到的資源照樣能從網路拿。
  event.waitUntil(caches.open(CACHE)
    .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names
      .filter((name) => name.startsWith('termux-os-admin-') && name !== CACHE)
      .map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 控制面的資料一律走網路。過期的狀態會被當成現況，比擺明連不上更糟。
  if (url.pathname.startsWith('/api/')) return;

  // 導覽請求先試網路：Framework 沒在跑時才用快取的殼，讓使用者至少看得到頁面而不是瀏覽器錯誤。
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/admin/status/overview')
      .then((hit) => hit ?? caches.match('/admin/style.css').then(() => Response.error()))));
    return;
  }

  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  })));
});
