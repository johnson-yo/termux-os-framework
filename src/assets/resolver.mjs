/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/assets/resolver.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readRegistry, sha256File } from './registry.mjs';
import { matchTarget } from '../packages/manifest.mjs';
import { deviceProfile } from '../packages/runtime-contract.mjs';

export const MISSING_REASON = (id) => `missing_asset:${id}`;

/**
 * 解析一個 asset（§8.1）。
 * verify=true 時逐檔算 sha 復驗——479MB 的 ctx 算一次要數秒，故只在**顯式要求**時做
 * （安裝時必驗；Service 每次啟動不必——那會讓啟動多等好幾秒）。
 *
 * 絕不做的事（§8.1）：靜默用錯 target、自動下載、自動挑一個不明來歷的舊模型、假裝 ready。
 */
export function resolveAsset(id, { profile = null, verify = false } = {}) {
  const reg = readRegistry();
  const e = reg.assets?.[id];
  if (!e) return { id, ready: false, reason: MISSING_REASON(id), detail: 'not registered (asset package not installed?)' };

  const dev = profile ?? deviceProfile();
  // target 綁定：ctx 綁 HTP 架構 + QNN 版本，換台機器就是廢的（023 已實證）
  const t = matchTarget({ id: e.target, ...(e.target_spec ?? {}) }, dev);
  if (!t.ok && e.target_spec) {
    return { id, ready: false, reason: `target_mismatch:${id}`, detail: t.reasons.join('; '), entry: e };
  }

  if (!e.path || !fs.existsSync(e.path)) {
    return { id, ready: false, reason: MISSING_REASON(id), detail: `payload path missing: ${e.path}`, entry: e };
  }

  const files = e.files ?? {};
  const missing = Object.entries(files)
    .filter(([, f]) => !fs.existsSync(path.join(e.path, f)))
    .map(([role, f]) => `${role}=${f}`);
  if (missing.length) {
    return { id, ready: false, reason: MISSING_REASON(id), detail: `payload incomplete: ${missing.join(', ')}`, entry: e };
  }

  if (verify) {
    for (const [rel, want] of Object.entries(e.checksums ?? {})) {
      const got = sha256File(path.join(e.path, rel));
      if (got !== want) {
        return { id, ready: false, reason: `checksum_mismatch:${id}`, detail: `${rel}: expected ${want}, got ${got}`, entry: e };
      }
    }
  }

  return {
    id, ready: true, reason: null,
    package: e.package_id, version: e.version, target: e.target, path: e.path,
    files, entry: e,
  };
}

/** 管理頁/API 用：只回已驗證的路徑與狀態，**不回模型內容**（§7.1） */
export function describeAsset(id, opts = {}) {
  const r = resolveAsset(id, opts);
  return {
    id: r.id, ready: r.ready, reason: r.reason, detail: r.detail ?? null,
    package: r.package ?? r.entry?.package_id ?? null,
    version: r.version ?? r.entry?.version ?? null,
    target: r.target ?? r.entry?.target ?? null,
    path: r.path ?? r.entry?.path ?? null,
    files: Object.keys(r.files ?? r.entry?.files ?? {}),
  };
}

export function listResolvedAssets(opts = {}) {
  const reg = readRegistry();
  return Object.keys(reg.assets ?? {}).sort().map((id) => describeAsset(id, opts));
}

// ============================================================
// 自檢：node src/assets/resolver.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  const { activateAsset } = await import('./registry.mjs');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assetres-'));
  process.env.ASSETS_REGISTRY_DIR = path.join(tmp, 'reg');
  const dev = { os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.47' };

  t('unregistered asset → missing_asset (not a crash)',
    resolveAsset('model.ghost', { profile: dev }).reason === 'missing_asset:model.ghost');

  const payload = path.join(tmp, 'store/pkg/0.1.0/android-arm64-v73-qnn247/sensevoice');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'model.ctx.onnx'), 'CTX');
  const sha = sha256File(path.join(payload, 'model.ctx.onnx'));
  const entry = {
    package_id: 'github.termux-os.asset.sensevoice', version: '0.1.0',
    target: 'android-arm64-v73-qnn247',
    target_spec: { os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.47' },
    path: payload, files: { context: 'model.ctx.onnx' }, sha256: sha,
    checksums: { 'model.ctx.onnx': sha },
  };
  activateAsset('model.sensevoice', entry);

  const ok = resolveAsset('model.sensevoice', { profile: dev, verify: true });
  t('registered + files + checksum → ready', ok.ready && ok.path === payload);

  t('wrong htp → target_mismatch (never silently used)',
    resolveAsset('model.sensevoice', { profile: { ...dev, htp: 'v79' } }).reason === 'target_mismatch:model.sensevoice');
  t('wrong qnn → target_mismatch',
    resolveAsset('model.sensevoice', { profile: { ...dev, qnn: '2.42' } }).reason === 'target_mismatch:model.sensevoice');

  fs.writeFileSync(path.join(payload, 'model.ctx.onnx'), 'TAMPERED');
  t('tampered payload → checksum_mismatch when verifying',
    resolveAsset('model.sensevoice', { profile: dev, verify: true }).reason === 'checksum_mismatch:model.sensevoice');
  t('verify=false skips checksum (startup must not pay 479MB hashing)',
    resolveAsset('model.sensevoice', { profile: dev, verify: false }).ready === true);

  fs.rmSync(path.join(payload, 'model.ctx.onnx'));
  t('deleted payload file → missing_asset',
    resolveAsset('model.sensevoice', { profile: dev }).reason === 'missing_asset:model.sensevoice');

  const d = describeAsset('model.sensevoice', { profile: dev });
  t('describeAsset exposes status/path but not content',
    d.ready === false && d.version === '0.1.0' && Array.isArray(d.files) && !('content' in d));

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
