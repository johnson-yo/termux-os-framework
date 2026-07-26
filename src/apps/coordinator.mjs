/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/apps/coordinator.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { listRegisteredApps, getRegisteredApp, listPackages, getPackage } from '../packages/loader.mjs';
import { describeCapability } from '../capabilities/resolver.mjs';
import * as stage from '../stage/manager.mjs';

// 逐項解析 App 的 Capability 依賴 → components + 需啟動 Service 清單
async function resolveComponents(app) {
  const components = [];
  const startServices = [];
  for (const req of app.requires ?? []) {
    const d = await describeCapability(req.id);
    const c = { capability: req.id, required: req.required !== false };
    if (d.ready) {
      c.state = 'ready';
      c.provider = d.provider;
    } else if (d.service && /is (stopped|exited)/.test(d.reason ?? '')) {
      c.state = 'stopped';
      c.provider = d.provider;
      c.reason = d.reason;
      startServices.push({ id: d.service, reason: `required by ${req.id}` });
    } else if (d.service) {
      c.state = 'warming'; // Provider 齊全、service 在跑但尚未就緒（如 llama 載入中）
      c.provider = d.provider;
      c.reason = d.reason;
    } else {
      c.state = 'unavailable'; // 無 Provider/無綁定/Package 壞——需要用戶去設置
      c.reason = d.reason;
      if (d.package) c.setup_url = `/packages/${d.package}/`;
    }
    // Package 已知時附設置頁鏈接（Required 不可用時的出口，021 §11.3）
    if (!c.setup_url && d.package) c.setup_url = `/packages/${d.package}/`;
    components.push(c);
  }
  return { components, startServices };
}

const summarize = (components) => {
  const required = components.filter((c) => c.required);
  if (required.some((c) => c.state === 'unavailable')) return 'blocked';
  if (required.some((c) => c.state === 'stopped')) return 'needs_services';
  if (required.some((c) => c.state === 'warming')) return 'warming';
  return 'ready';
};

export async function getAppState(appId) {
  const app = getRegisteredApp(appId);
  if (!app) return null;
  const { components, startServices } = await resolveComponents(app);
  const state = summarize(components);
  return {
    id: app.id, name: app.name, package: app.package, url: app.url,
    state, enabled: true, components,
    ...(state === 'needs_services' ? { start_services: startServices } : {}),
  };
}

export async function listAppsWithState() {
  const registered = await Promise.all(listRegisteredApps().map((a) => getAppState(a.id)));
  const result = [...registered];
  const known = new Set(registered.map((app) => app.package));
  for (const pkg of listPackages()) {
    if (known.has(pkg.id)) continue;
    const manifest = getPackage(pkg.id)?.manifest;
    for (const declared of manifest?.components?.apps ?? []) {
      const app = typeof declared === 'string' ? { id: declared, name: declared } : declared;
      if (!app?.id) continue;
      result.push({
        id: app.id,
        name: app.name ?? app.title ?? manifest.admin?.title ?? pkg.name ?? app.id,
        package: pkg.id,
        url: `/packages/${pkg.id}/`,
        state: pkg.status === 'disabled' ? 'disabled' : 'unavailable',
        enabled: pkg.status !== 'disabled',
        components: [],
      });
    }
  }
  return result;
}

// 輪詢式 prepare：客戶端反覆 POST，直到 ready:true 或收到 blocked/consent_required
export async function prepareApp(appId, { approveStart = false } = {}) {
  const app = getRegisteredApp(appId);
  if (!app) return { ready: false, error: 'unknown_app' };
  let { components, startServices } = await resolveComponents(app);
  let state = summarize(components);

  if (state === 'blocked') {
    return { ready: false, state, components,
      error: 'required_capability_unavailable' };
  }

  if (state === 'needs_services') {
    if (!approveStart) {
      return { ready: false, consent_required: true, start_services: startServices, components };
    }
    for (const s of startServices) await stage.startService(s.id); // 冪等；desired=running
    ({ components } = await resolveComponents(app));
    state = summarize(components);
  }

  if (state === 'ready') return { ready: true, url: app.url, components };
  return { ready: false, state, components }; // warming：客戶端繼續輪詢
}
