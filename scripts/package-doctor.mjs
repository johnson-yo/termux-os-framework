/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: scripts/package-doctor.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILENAME, validateManifest } from '../src/packages/manifest.mjs';
import { loadPackages, listPackages, getPackage, listCapabilityProviders, listRegisteredApps } from '../src/packages/loader.mjs';
import { getAction } from '../src/theatre/runtime.mjs';
import { services as stageServices } from '../src/stage/catalog.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// --root <dir>：對任意 Package 集合體檢（如 Release 解壓目錄）；默認 Source 樹
const rootArg = process.argv.indexOf('--root');
const PKG_ROOT = rootArg >= 0 ? path.resolve(process.argv[rootArg + 1]) : path.join(ROOT, 'packages');
const FRAMEWORK_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let fails = 0;
const t = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails += 1;
};

// 實際載入（in-process 註冊，不 spawn 進程）——註冊一致性只有真載入才驗得出
await loadPackages({ roots: [PKG_ROOT], frameworkVersion: FRAMEWORK_VERSION, config: {}, log: () => {} });
const all = listPackages();
console.log(`packages under doctor: ${all.length}`);

t('no duplicate / all loadable', all.every((p) => p.status === 'loaded'),
  all.filter((p) => p.status !== 'loaded').map((p) => `${p.id}:${p.status} ${p.error ?? ''}`).join('; '));

for (const { id } of all) {
  const rec = getPackage(id);
  const dir = rec.dir;
  const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf8'));
  const v = validateManifest(m, { frameworkVersion: FRAMEWORK_VERSION });
  t(`${id}: manifest valid`, v.ok && v.compatible, v.errors.join('; '));
  t(`${id}: backend exists`, fs.existsSync(path.join(dir, m.entrypoints.backend)));
  t(`${id}: webui entry exists`, fs.existsSync(path.join(dir, m.entrypoints.webui)));
  t(`${id}: webui stays inside package`, !m.entrypoints.webui.split('/').includes('..')
    && path.resolve(dir, m.entrypoints.webui).startsWith(dir + path.sep));
  for (const f of ['README.md', 'NOTICE.md', 'LICENSE']) {
    t(`${id}: ${f} exists`, fs.existsSync(path.join(dir, f)));
  }

  // 聲明 vs 實際註冊一致（雙向）
  const decl = m.components ?? {};
  const declActions = decl.actions ?? [];
  const declServices = decl.services ?? [];
  const declApps = decl.apps ?? [];
  const actActions = declActions.filter((a) => getAction(a)?.package === id);
  t(`${id}: declared actions all registered`, actActions.length === declActions.length,
    `declared ${declActions.length}, registered ${actActions.length}`);
  const actServices = declServices.filter((s) => stageServices.find((x) => x.id === s)?.package === id);
  t(`${id}: declared services all registered`, actServices.length === declServices.length);
  const regApps = listRegisteredApps().filter((a) => a.package === id).map((a) => a.id);
  t(`${id}: declared apps all registered`, declApps.every((a) => regApps.includes(a)) && regApps.every((a) => declApps.includes(a)),
    `declared [${declApps}], registered [${regApps}]`);

  // Provider 聲明 vs 註冊一致 + action 引用存在
  const declProvides = m.capabilities?.provides ?? [];
  const regProviders = listCapabilityProviders().filter((p) => p.package === id);
  t(`${id}: declared providers all registered`, declProvides.length === regProviders.length
    && declProvides.every((d) => regProviders.some((r) => r.id === d.id && r.provider === d.provider)));
  for (const p of declProvides) {
    if (p.kind === 'action') t(`${id}: provider ${p.id} action exists`, Boolean(getAction(p.action)));
    // feed endpoint 兩種合法形態：framework 路由（/...）或 loopback 熱路徑直連（ws://127.0.0.1:...，
    // 027 audio.pcm——PCM 不過 framework HTTP）；外部網址一律不合法
    if (p.kind === 'feed') {
      const registered = regProviders.find((r) => r.id === p.id && r.provider === p.provider);
      let endpoint = p.endpoint;
      if (!endpoint && typeof registered?.connection === 'function') {
        try { endpoint = (await registered.connection())?.endpoint; } catch { endpoint = null; }
      }
      t(`${id}: provider ${p.id} has endpoint`, typeof endpoint === 'string'
        && (endpoint.startsWith('/') || endpoint.startsWith('ws://127.0.0.1:')));
    }
  }

  // App Required Capability 可解析（有 Provider 註冊）
  for (const r of m.capabilities?.requires ?? []) {
    const capId = typeof r === 'string' ? r : r.id;
    const optional = typeof r === 'object' && r?.required === false;
    const resolvable = listCapabilityProviders().some((p) => p.id === capId);
    t(`${id}: required capability ${capId} resolvable`, resolvable || optional,
      resolvable ? '' : 'no provider registered (optional tolerated)');
  }
}

console.log('----');
if (fails) { console.log(`PACKAGE DOCTOR: ${fails} FAIL`); process.exit(1); }
console.log('PACKAGE DOCTOR: all PASS');
