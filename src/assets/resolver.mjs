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
import { readPayloadLedger, payloadLedgerPath, selectionKey, sharedStore, payloadObjectDir } from './registry.mjs';
import { readDeclarationIndex, declarationsForAsset } from './declarations.mjs';
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
function resolveAssetLegacy(id, { profile = null, verify = false } = {}) {
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
function describeAssetLegacy(id, opts = {}) {
  const r = resolveAssetLegacy(id, opts);
  return {
    id: r.id, ready: r.ready, reason: r.reason, detail: r.detail ?? null,
    package: r.package ?? r.entry?.package_id ?? null,
    version: r.version ?? r.entry?.version ?? null,
    target: r.target ?? r.entry?.target ?? null,
    path: r.path ?? r.entry?.path ?? null,
    files: Object.keys(r.files ?? r.entry?.files ?? {}),
  };
}

function listResolvedAssetsLegacy(opts = {}) {
  const reg = readRegistry();
  return Object.keys(reg.assets ?? {}).sort().map((id) => describeAssetLegacy(id, opts));
}

const selectedFor = (ledger, assetId, variantId) => ledger.selections?.[selectionKey(assetId, variantId)] ?? null;

const v2FileMap = (payload) => Object.fromEntries((payload?.files ?? []).map((file) => [file.role ?? file.path, file.path]));
const safePayloadPath = (value) => {
  const relative = String(value ?? '');
  return Boolean(relative && !path.posix.isAbsolute(relative) && !relative.includes('\\')
    && path.posix.normalize(relative) === relative && !relative.split('/').includes('..'));
};
const inside = (root, candidate) => {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
};

/** Select a declaration variant without choosing a Payload. */
function selectV2Declaration(index, assetId, profile) {
  const variants = declarationsForAsset(index, assetId);
  if (!variants.length) return { ok: false, error: `unregistered:${assetId}`, detail: `${assetId} has no active Asset Declaration`, candidates: [] };
  const candidates = variants.map((item) => item.variant_id);
  const matches = variants.filter((item) => matchTarget(item.target, profile).ok);
  if (!matches.length) {
    const detail = variants.map((item) => `${item.variant_id}: ${matchTarget(item.target, profile).reasons.join('; ')}`).join(' | ');
    return { ok: false, error: `target_mismatch:${assetId}`, detail, candidates };
  }
  if (matches.length > 1) {
    return { ok: false, error: `ambiguous_declaration:${assetId}`, detail: 'multiple active Packages declare the same Asset variant', candidates: matches.map((item) => item.declaration_id) };
  }
  return { ok: true, declaration: matches[0], candidates };
}

/**
 * v2 resolver: Declaration, Selection, Payload, and runtime facts remain
 * separate. In particular, no declaration optionality or provider load state
 * is consulted when deciding whether a selected payload is usable.
 */
export function resolveAssetV2(assetId, { profile = null, verify = false, index = null, ledger = null } = {}) {
  const declarations = index ?? readDeclarationIndex();
  const picked = selectV2Declaration(declarations, assetId, profile ?? deviceProfile());
  if (!picked.ok) {
    return {
      id: assetId,
      registration_state: declarationsForAsset(declarations, assetId).length ? 'registered' : 'unregistered',
      payload_state: 'missing',
      selection: null,
      ready: false,
      reason: picked.error,
      detail: picked.detail,
      candidates: picked.candidates,
    };
  }
  const declaration = picked.declaration;
  const current = ledger ?? readPayloadLedger();
  if (current.error) {
    return {
      id: assetId, registration_state: 'registered', payload_state: 'ledger_error', selection: null,
      ready: false, reason: 'payload_ledger_corrupt', detail: current.error, declaration,
    };
  }
  const selection = selectedFor(current, assetId, declaration.variant_id);
  if (!selection) {
    return {
      id: assetId, registration_state: 'registered', payload_state: 'missing', selection: null,
      ready: false, reason: `payload_missing:${assetId}`, detail: 'no Manager Selection for this declaration variant', declaration,
    };
  }
  const payload = current.payloads?.[selection.payload_id];
  if (!payload || payload.state === 'deleting') {
    return {
      id: assetId, registration_state: 'registered', payload_state: payload?.state ?? 'missing', selection,
      ready: false, reason: `payload_missing:${assetId}`, detail: `selected payload ${selection.payload_id} is not ready`, declaration,
    };
  }
  const root = path.resolve(String(payload.storage_path ?? ''));
  if (!inside(sharedStore(), root)) {
    return {
      id: assetId, registration_state: 'registered', payload_state: 'incompatible', selection,
      payload_id: payload.payload_id, ready: false, reason: 'payload_path_outside_store',
      detail: `payload path is outside shared store: ${payload.storage_path}`, declaration,
    };
  }
  if (payload.layout === 'object' && root !== path.resolve(payloadObjectDir(payload.payload_id))) {
    return {
      id: assetId, registration_state: 'registered', payload_state: 'incompatible', selection,
      payload_id: payload.payload_id, ready: false, reason: 'payload_object_path_mismatch',
      detail: `object payload path does not match ${payload.payload_id}`, declaration,
    };
  }
  if (!root || !fs.existsSync(root)) {
    return {
      id: assetId, registration_state: 'registered', payload_state: 'missing', selection, payload_id: payload.payload_id,
      ready: false, reason: `payload_missing:${assetId}`, detail: `payload path missing: ${payload.storage_path}`, declaration,
    };
  }
  const files = v2FileMap(payload);
  const missing = (payload.files ?? []).filter((file) => !fs.existsSync(path.resolve(root, file.path)));
  if (missing.length) {
    return {
      id: assetId, registration_state: 'registered', payload_state: 'missing', selection, payload_id: payload.payload_id,
      ready: false, reason: `payload_missing:${assetId}`, detail: `payload incomplete: ${missing.map((file) => file.path).join(', ')}`, declaration,
    };
  }
  const declaredPaths = Object.values(declaration.files ?? {});
  const unsafeDeclared = declaredPaths.filter((file) => !safePayloadPath(file));
  if (unsafeDeclared.length || declaredPaths.some((file) => !Object.values(files).includes(file))) {
    return {
      id: assetId, registration_state: 'registered', payload_state: 'incompatible', selection,
      payload_id: payload.payload_id, ready: false, reason: 'payload_declaration_mismatch',
      detail: `selected payload does not satisfy Declaration files: ${declaredPaths.join(', ')}`, declaration,
    };
  }
  if (verify) {
    for (const file of payload.files ?? []) {
      const actual = sha256File(path.resolve(root, file.path));
      if (actual !== file.sha256) {
        return {
          id: assetId, registration_state: 'registered', payload_state: 'incompatible', selection,
          payload_id: payload.payload_id, ready: false, reason: `checksum_mismatch:${assetId}`,
          detail: `${file.path}: expected ${file.sha256}, got ${actual}`, declaration,
        };
      }
    }
  }
  return {
    id: assetId,
    registration_state: 'registered',
    payload_state: 'ready',
    selection,
    payload_id: payload.payload_id,
    ready: true,
    reason: null,
    package: declaration.package_id,
    version: declaration.package_version,
    target: declaration.variant_id,
    path: root,
    files,
    declaration,
  };
}

export function describeAssetV2(assetId, opts = {}) {
  const result = resolveAssetV2(assetId, opts);
  return {
    id: result.id,
    registration_state: result.registration_state,
    payload_state: result.payload_state,
    ready: result.ready,
    reason: result.reason ?? null,
    detail: result.detail ?? null,
    declaration: result.declaration ? {
      declaration_id: result.declaration.declaration_id,
      asset_id: result.declaration.asset_id,
      variant_id: result.declaration.variant_id,
      kind: result.declaration.kind,
      optional: result.declaration.optional,
      package_id: result.declaration.package_id,
      package_version: result.declaration.package_version,
      target: result.declaration.target,
      files: result.declaration.files,
    } : null,
    selection: result.selection ?? null,
    payload_id: result.payload_id ?? null,
    path: result.path ?? null,
    files: Object.keys(result.files ?? {}),
  };
}

export function listResolvedAssetsV2({ index = null, ledger = null, profile = null, verify = false } = {}) {
  const declarations = index ?? readDeclarationIndex();
  const ids = [...new Set((declarations.declarations ?? []).map((item) => item.asset_id))].sort();
  return ids.map((id) => describeAssetV2(id, { index: declarations, ledger, profile, verify }));
}

const hasV2Declaration = (index, id) => declarationsForAsset(index, id).length > 0;

const useV2 = (id, opts = {}) => {
  const index = opts.index ?? readDeclarationIndex();
  const ledger = opts.ledger ?? readPayloadLedger();
  // Once a v2 ledger is present, including a corrupt one, the compatibility
  // entrypoint must stay on v2. Falling back to the v1 projection here would
  // make a damaged ledger look like a valid old Payload and could resolve
  // bytes that v2 has explicitly declared unreadable.
  return hasV2Declaration(index, id)
    && (ledger.error || fs.existsSync(payloadLedgerPath()) || Object.keys(ledger.payloads ?? {}).length > 0);
};

/** Compatibility entrypoint: active-package declarations take precedence once v2 exists. */
export function resolveAsset(id, opts = {}) {
  return useV2(id, opts) ? resolveAssetV2(id, opts) : resolveAssetLegacy(id, opts);
}

export function describeAsset(id, opts = {}) {
  return useV2(id, opts) ? describeAssetV2(id, opts) : describeAssetLegacy(id, opts);
}

export function listResolvedAssets(opts = {}) {
  const index = opts.index ?? readDeclarationIndex();
  const ledger = opts.ledger ?? readPayloadLedger();
  if (ledger.error || fs.existsSync(payloadLedgerPath())) return listResolvedAssetsV2({ ...opts, index, ledger });
  return listResolvedAssetsLegacy(opts);
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

  // A v2 declaration plus a corrupt v2 ledger must never fall through to the
  // still-present v1 projection. The caller needs an explicit repair signal.
  const corruptPayload = path.join(tmp, 'store/corrupt/model.ctx.onnx');
  fs.mkdirSync(path.dirname(corruptPayload), { recursive: true });
  fs.writeFileSync(corruptPayload, 'legacy fallback must not win');
  const corruptSha = sha256File(corruptPayload);
  activateAsset('model.corrupt', {
    package_id: 'github.termux-os.asset.corrupt', version: '0.1.0', target: 'generic',
    path: path.dirname(corruptPayload), files: { context: path.basename(corruptPayload) }, checksums: { [path.basename(corruptPayload)]: corruptSha },
  });
  fs.writeFileSync(payloadLedgerPath(), '{"schema":"termux-os.asset-payload-ledger.v2","payloads":');
  const corruptIndex = { declarations: [{
    declaration_id: 'pkg.corrupt@0.1.0:model.corrupt:generic', asset_id: 'model.corrupt', variant_id: 'generic',
    kind: 'model', optional: false, package_id: 'pkg.corrupt', package_version: '0.1.0', target: null,
    files: { context: path.basename(corruptPayload) },
  }] };
  t('corrupt v2 ledger does not fall back to v1 resolution',
    resolveAsset('model.corrupt', { profile: dev, index: corruptIndex }).reason === 'payload_ledger_corrupt');
  t('corrupt v2 ledger is visible in list projection',
    listResolvedAssets({ profile: dev, index: corruptIndex }).find((item) => item.id === 'model.corrupt')?.reason === 'payload_ledger_corrupt');

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
