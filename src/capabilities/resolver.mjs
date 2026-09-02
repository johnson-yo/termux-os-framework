/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/capabilities/resolver.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listCapabilityProviders, getPackage } from '../packages/loader.mjs';
import { getAction } from '../theatre/runtime.mjs';
import * as stage from '../stage/manager.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const BINDINGS_PATH = process.env.CAP_BINDINGS_PATH
  || (fs.existsSync('/sdcard/termux-os')
    ? '/sdcard/termux-os/framework/conf/providers.v1.json'
    : path.join(ROOT, '.runtime/persist/conf/providers.v1.json'));

const readBindings = () => {
  try { return JSON.parse(fs.readFileSync(BINDINGS_PATH, 'utf8')).bindings ?? {}; }
  catch { return {}; }
};

const providersFor = (capId) => listCapabilityProviders().filter((p) => p.id === capId);
let capabilityStateChangeHandler = null;
const observedReadiness = new Map();

/** Core observes transitions; this resolver remains the sole readiness source of truth. */
export function setCapabilityStateChangeHandler(fn) {
  capabilityStateChangeHandler = typeof fn === 'function' ? fn : null;
}

function observeReadiness(capId, result) {
  const ready = result?.ready === true;
  const previous = observedReadiness.get(capId);
  observedReadiness.set(capId, ready);
  if (previous !== undefined && previous !== ready && capabilityStateChangeHandler) {
    try {
      const event = capabilityStateChangeHandler({
        kind: 'capability_readiness_changed', capability: capId, previous, ready,
        reason: result?.reason ?? null,
      });
      if (event && typeof event.catch === 'function') event.catch(() => {});
    } catch { /* Readiness observation must not change the resolver result. */ }
  }
  return result;
}

/**
 * Feed 的連線資料可由 Provider 靜態聲明，也可用 connection() 隨配置即時生成。
 * Framework 只裁決 Provider 並返回 descriptor，不代理高頻資料。
 */
export async function resolveFeedConnection(provider) {
  const dynamic = typeof provider.connection === 'function'
    ? await provider.connection()
    : (provider.connection ?? {});
  const endpoint = dynamic?.endpoint ?? provider.endpoint ?? null;
  const format = dynamic?.format ?? provider.format ?? 'jsonl-cursor';
  const headers = dynamic?.headers ?? provider.headers;
  return {
    endpoint,
    format,
    ...(headers && typeof headers === 'object' && Object.keys(headers).length ? { headers } : {}),
  };
}

// 綁定真相 = 持久文件；未持久化且唯一 Provider 時隱式默認（不寫盤）
export function getCapabilityBinding(capId) {
  const persisted = readBindings()[capId];
  if (persisted) return persisted;
  const ps = providersFor(capId);
  return ps.length === 1 ? ps[0].provider : null;
}

export function setCapabilityBinding(capId, providerId) {
  const ps = providersFor(capId);
  if (!ps.length) return { ok: false, error: 'unknown_capability', capability: capId };
  if (!ps.some((p) => p.provider === providerId)) {
    return { ok: false, error: 'unknown_provider', capability: capId, provider: providerId,
      known: ps.map((p) => p.provider) };
  }
  const bindings = { ...readBindings(), [capId]: providerId };
  fs.mkdirSync(path.dirname(BINDINGS_PATH), { recursive: true });
  fs.writeFileSync(BINDINGS_PATH, `${JSON.stringify({ schema: 'termux-os-framework.providers.v1', bindings }, null, 2)}\n`);
  try {
    const event = capabilityStateChangeHandler?.({ kind: 'capability_binding_changed', capability: capId, provider: providerId });
    if (event && typeof event.catch === 'function') event.catch(() => {});
  } catch { /* Binding persistence already succeeded; observer failure is non-fatal. */ }
  return { ok: true, capability: capId, provider: providerId };
}

// 解析 + 就緒判定；ready=false 必帶 reason（禁止假裝 Ready，021 §11.3）
export async function describeCapability(capId) {
  const ps = providersFor(capId);
  const finish = (result) => observeReadiness(capId, result);
  if (!ps.length) return finish({ ok: false, capability: capId, error: 'no_provider', ready: false, reason: 'no provider registered' });
  const bound = getCapabilityBinding(capId);
  if (!bound) return finish({ ok: false, capability: capId, error: 'no_binding', ready: false, reason: 'multiple providers, none bound', providers: ps.map((p) => p.provider) });
  const p = ps.find((x) => x.provider === bound);
  if (!p) return finish({ ok: false, capability: capId, error: 'bound_provider_not_registered', ready: false, reason: `bound provider "${bound}" is not registered`, providers: ps.map((x) => x.provider) });

  const base = { ok: true, capability: capId, kind: p.kind, provider: p.provider, package: p.package,
    providers: ps.map((x) => x.provider) };

  const pkg = getPackage(p.package);
  if (pkg && pkg.status !== 'loaded') return finish({ ...base, ready: false, reason: `package ${p.package} is ${pkg.status}` });

  if (p.service) {
    const st = await stage.getServiceStatus(p.service);
    if (!st || st.process?.state !== 'running') {
      return finish({ ...base, service: p.service, ready: false, reason: `service ${p.service} is ${st?.process?.state ?? 'unknown'}` });
    }
    base.service = p.service;
    base.service_health = st.health?.state ?? 'unknown';
  }

  if (p.kind === 'feed') {
    let feed;
    try { feed = await resolveFeedConnection(p); }
    catch (e) {
      return finish({ ...base, ready: false, reason: `feed descriptor failed: ${String(e?.message ?? e)}` });
    }
    const described = { ...base, ...feed };
    if (!feed.endpoint) return finish({ ...described, ready: false, reason: 'feed provider has no endpoint' });
    if (typeof p.available === 'function') {
      let available = false;
      try { available = Boolean(await p.available()); } catch { available = false; }
      if (!available) return finish({ ...described, ready: false, reason: `feed provider ${p.provider} unavailable` });
    }
    return finish({ ...described, ready: true });
  }
  const action = getAction(p.action);
  if (!action) return finish({ ...base, ready: false, reason: `action ${p.action} not registered` });
  let available = false;
  try { available = Boolean(await action.available()); } catch { available = false; }
  if (!available) return finish({ ...base, action: p.action, ready: false, reason: `action ${p.action} unavailable` });
  return finish({ ...base, action: p.action, ready: true });
}

export async function invokeCapability(capId, input) {
  const d = await describeCapability(capId);
  if (!d.ok) return d;
  if (d.kind === 'feed') {
    return { ok: false, capability: capId, error: 'feed_capability', feed: {
      endpoint: d.endpoint, format: d.format, ...(d.headers ? { headers: d.headers } : {}),
      ready: d.ready, reason: d.reason,
    } };
  }
  if (!d.ready) return { ok: false, capability: capId, error: 'provider_not_ready', reason: d.reason, provider: d.provider };
  try {
    const value = await getAction(d.action).run(input);
    return { ok: true, capability: capId, provider: d.provider, value };
  } catch (e) {
    return { ok: false, capability: capId, provider: d.provider, error: 'provider_failed', reason: String(e?.message ?? e) };
  }
}

export async function listCapabilities() {
  const ids = [...new Set(listCapabilityProviders().map((p) => p.id))].sort();
  return Promise.all(ids.map(async (id) => {
    const d = await describeCapability(id);
    return { capability: id, kind: d.kind ?? null, binding: getCapabilityBinding(id),
      providers: providersFor(id).map((p) => p.provider), ready: d.ready === true, reason: d.reason ?? null };
  }));
}

// ============================================================
// 自檢：node src/capabilities/resolver.mjs --capability-self-test
// （不用通用 --self-test，避免依賴的 Stage 模塊把參數誤認成自己的入口。）
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--capability-self-test') && process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const legacy = await resolveFeedConnection({ endpoint: '/feed' });
  t('legacy feed keeps jsonl-cursor default', legacy.endpoint === '/feed' && legacy.format === 'jsonl-cursor');
  const dynamic = await resolveFeedConnection({ connection: async () => ({
    endpoint: 'ws://127.0.0.1:1/pinyin', format: 'termux-os.pinyin-stream.v1',
    headers: { Authorization: 'Bearer test' },
  }) });
  t('dynamic feed preserves transport contract', dynamic.endpoint.startsWith('ws://')
    && dynamic.format === 'termux-os.pinyin-stream.v1' && dynamic.headers.Authorization === 'Bearer test');
  process.exit(fails ? 1 : 0);
}
