/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: web/admin/session.js in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

(() => {
  const nativeFetch = window.fetch.bind(window);
  const state = { session: null };
  const login = () => {
    const next = `${location.pathname}${location.search}`;
    location.replace(`/admin/login?next=${encodeURIComponent(next)}`);
  };

  const ready = nativeFetch('/api/auth/session', { cache: 'no-store' }).then(async (response) => {
    if (!response.ok) {
      login();
      throw new Error('browser_session_required');
    }
    state.session = await response.json();
    return state.session;
  });

  const api = async (url, options = {}) => {
    await ready;
    const method = String(options.method ?? 'GET').toUpperCase();
    const headers = new Headers(options.headers ?? {});
    if (options.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('X-CSRF-Token', state.session.csrf_token);
    }
    // 旧 Package 若仍传无效 Bearer，统一移除；Browser 认证只认 HttpOnly Cookie。
    headers.delete('Authorization');
    const response = await nativeFetch(url, { ...options, method, headers, cache: options.cache ?? 'no-store' });
    if (response.status === 401) login();
    return response;
  };

  const logout = async () => {
    const response = await api('/api/auth/logout', { method: 'POST' });
    if (response.ok) location.replace('/admin/login');
    return response;
  };

  window.TermuxOS = { ready, api, logout, get session() { return state.session; } };
  // Host 注入旧 Installed Package 页面时，它们仍可能直接 fetch；同源 /api 自动升级为 Browser Session。
  window.fetch = (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    return url.origin === location.origin && url.pathname.startsWith('/api/')
      ? api(input, options)
      : nativeFetch(input, options);
  };
})();
