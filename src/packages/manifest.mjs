/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: Manifest validation, including public pre-install dependency and security metadata.
 * [POS]: src/packages/manifest.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export const MANIFEST_FILENAME = 'termux-os.package.json';
export const MANIFEST_SCHEMA = 'termux-os.package.v1';

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){3,}$/; // github.<owner>.<category>.<name>
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PORT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PORT_PROTOCOLS = new Set(['http', 'https']);
const PORT_VISIBILITY = new Set(['loopback', 'lan']);
const TYPES = new Set(['adapter', 'service', 'app', 'asset']); // 024：asset = 大型模型資產包
const PACKAGE_MENU_PARENTS = new Set([
  '/admin/status', '/admin/applications', '/admin/services', '/admin/system', '/admin/packages', '/admin/adapters',
]);

// entrypoint 只許 package 根內的相對路徑（不許絕對路徑/越界）
const relPathOk = (p) => typeof p === 'string' && p.length > 0
  && !p.startsWith('/') && !p.split('/').includes('..');

// ============================================================
// 023：Runtime Contract 與 Target（皆為可選；不聲明=legacy/generic，見 §3.2）
// ============================================================
export const TARGET_GENERIC = 'generic';
export const RUNTIME_LEGACY = 'legacy';

const BUNDLED_TYPES = new Set(['executable', 'shared_library', 'file']);
const PROBE_TYPES = new Set(['command', 'file', 'python_import', 'framework_action']);
const TARGET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const QNN_RE = /^\d+\.\d+$/;
const HTP_RE = /^v\d{2}$/;

/**
 * probe 兩種寫法歸一：字符串 = framework_action 簡寫（023 §3 示例的 "android.app.status"），
 * 對象 = { type, value }。歸一後全系統只處理對象形式。
 */
export function normalizeProbe(p) {
  if (typeof p === 'string') return { type: 'framework_action', value: p };
  if (p && typeof p === 'object' && !Array.isArray(p)) return { type: p.type, value: p.value };
  return null;
}

function checkProbe(e, where, probe) {
  const n = normalizeProbe(probe);
  if (!n) { e(`${where}.probe must be a string or { type, value }`); return; }
  if (!PROBE_TYPES.has(n.type)) e(`${where}.probe.type must be one of [${[...PROBE_TYPES].join(', ')}]`);
  if (typeof n.value !== 'string' || !n.value.trim()) e(`${where}.probe.value is required`);
}

function validateRuntime(e, runtime) {
  if (runtime === undefined) return;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) { e('runtime must be an object'); return; }

  const cmds = runtime.framework?.commands;
  if (cmds !== undefined) {
    if (!Array.isArray(cmds) || cmds.some((c) => typeof c !== 'string' || !c.trim())) {
      e('runtime.framework.commands must be an array of non-empty strings');
    }
  }

  for (const [key, needProbe] of [['termux_packages', true], ['external', true]]) {
    const list = runtime[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { e(`runtime.${key} must be an array`); continue; }
    list.forEach((item, i) => {
      const where = `runtime.${key}[${i}]`;
      if (!item || typeof item !== 'object') { e(`${where} must be an object`); return; }
      if (typeof item.id !== 'string' || !item.id.trim()) e(`${where}.id is required`);
      if (item.required !== undefined && typeof item.required !== 'boolean') e(`${where}.required must be boolean`);
      if (needProbe) checkProbe(e, where, item.probe);
    });
  }

  const bundled = runtime.bundled;
  if (bundled !== undefined) {
    if (!Array.isArray(bundled)) { e('runtime.bundled must be an array'); return; }
    bundled.forEach((item, i) => {
      const where = `runtime.bundled[${i}]`;
      if (!item || typeof item !== 'object') { e(`${where} must be an object`); return; }
      // 包內相對路徑：與 entrypoints 同一條紅線（絕對路徑/../ 越界一律拒）
      if (!relPathOk(item.path)) e(`${where}.path must be a relative path inside the package`);
      if (!BUNDLED_TYPES.has(item.type)) e(`${where}.type must be one of [${[...BUNDLED_TYPES].join(', ')}]`);
      if (item.required !== undefined && typeof item.required !== 'boolean') e(`${where}.required must be boolean`);
    });
  }
}

function validateTargets(e, targets) {
  if (targets === undefined) return;
  if (!Array.isArray(targets) || targets.length === 0) { e('targets must be a non-empty array when declared'); return; }
  targets.forEach((t, i) => {
    const where = `targets[${i}]`;
    if (!t || typeof t !== 'object') { e(`${where} must be an object`); return; }
    if (typeof t.id !== 'string' || !TARGET_ID_RE.test(t.id)) e(`${where}.id must be lowercase [a-z0-9-]`);
    if (t.id === TARGET_GENERIC) { // generic 是「不聲明」的保留語義，不許顯式冒名
      e(`${where}.id "${TARGET_GENERIC}" is reserved for packages that declare no target`);
    }
    if (typeof t.os !== 'string' || !t.os.trim()) e(`${where}.os is required`);
    if (typeof t.arch !== 'string' || !t.arch.trim()) e(`${where}.arch is required`);
    if (t.htp !== undefined && !HTP_RE.test(String(t.htp))) e(`${where}.htp must look like "v73"`);
    if (t.qnn !== undefined && !QNN_RE.test(String(t.qnn))) e(`${where}.qnn must look like "2.47"`);
  });
  const ids = targets.map((t) => t?.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) e('targets[].id must be unique');
}

// ============================================================
// 024：Asset（大型模型資產）宣告
// ============================================================
const ASSET_KINDS = new Set(['model']);

function validateAssets(e, assets) {
  if (assets === undefined) return;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) { e('assets must be an object'); return; }

  const provides = assets.provides;
  if (provides !== undefined) {
    if (!Array.isArray(provides)) { e('assets.provides must be an array'); return; }
    provides.forEach((a, i) => {
      const where = `assets.provides[${i}]`;
      if (!a || typeof a !== 'object') { e(`${where} must be an object`); return; }
      if (typeof a.id !== 'string' || !a.id.trim()) e(`${where}.id is required`);
      if (!ASSET_KINDS.has(a.kind)) e(`${where}.kind must be one of [${[...ASSET_KINDS].join(', ')}]`);
      // payload 與 entrypoints/bundled 同一條紅線：包內相對路徑
      if (!relPathOk(a.payload)) e(`${where}.payload must be a relative path inside the package`);
      if (!a.files || typeof a.files !== 'object' || Array.isArray(a.files)) {
        e(`${where}.files must be an object mapping role → filename`);
      } else {
        for (const [role, f] of Object.entries(a.files)) {
          // 只許檔名，不許再往下鑽目錄——payload 目錄就是邊界
          if (typeof f !== 'string' || !f || f.includes('/')) e(`${where}.files.${role} must be a bare filename`);
        }
      }
    });
    const ids = provides.map((a) => a?.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) e('assets.provides[].id must be unique');
  }

  const requires = assets.requires;
  if (requires !== undefined) {
    if (!Array.isArray(requires)) { e('assets.requires must be an array'); return; }
    requires.forEach((a, i) => {
      const where = `assets.requires[${i}]`;
      if (!a || typeof a !== 'object') { e(`${where} must be an object`); return; }
      if (typeof a.id !== 'string' || !a.id.trim()) e(`${where}.id is required`);
      if (a.required !== undefined && typeof a.required !== 'boolean') e(`${where}.required must be boolean`);
      // target:"current" = 必須與本機 profile 相符（024 §8）；其餘值保留未用
      if (a.target !== undefined && a.target !== 'current') e(`${where}.target must be "current" (v0)`);
    });
  }
}

// ============================================================
// 025：App Runtime Session（可選；只有 App 用得上）
// ============================================================
function validateSession(e, sess) {
  if (sess === undefined) return;
  if (!sess || typeof sess !== 'object' || Array.isArray(sess)) { e('session must be an object'); return; }
  const caps = sess.required_capabilities;
  if (caps !== undefined && (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string' || !c.trim()))) {
    e('session.required_capabilities must be an array of capability ids');
  }
  for (const k of ['quiesce_unrelated_services', 'restore_on_stop']) {
    if (sess[k] !== undefined && typeof sess[k] !== 'boolean') e(`session.${k} must be boolean`);
  }
}

// ============================================================
// 029 §12：Integration Contract（可選）——跨組件 API 依賴按 capability 宣告，不比 App 版本號
// ============================================================
function validateIntegrations(e, integ) {
  if (integ === undefined) return;
  if (!integ || typeof integ !== 'object' || Array.isArray(integ)) { e('integrations must be an object'); return; }
  if (integ.provides !== undefined
    && (!Array.isArray(integ.provides) || integ.provides.some((c) => typeof c !== 'string' || !c.trim()))) {
    e('integrations.provides must be an array of capability ids');
  }
  if (integ.requires !== undefined) {
    if (!Array.isArray(integ.requires)) { e('integrations.requires must be an array'); return; }
    integ.requires.forEach((r, i) => {
      if (!r || typeof r !== 'object') { e(`integrations.requires[${i}] must be an object`); return; }
      if (typeof r.capability !== 'string' || !r.capability.trim()) e(`integrations.requires[${i}].capability is required`);
      if (r.required !== undefined && typeof r.required !== 'boolean') e(`integrations.requires[${i}].required must be boolean`);
      if (r.required !== true && (typeof r.degraded_behavior !== 'string' || !r.degraded_behavior.trim())) {
        e(`integrations.requires[${i}].degraded_behavior is required for optional integrations（缺了它用戶不知道少什麼）`);
      }
    });
  }
}

// ============================================================
// 029 §12.4：跨組件 Artifact 只讀契約（可選）——消費方問契約拿位置，不硬編碼別家裸路徑
// ============================================================
function validateArtifactsContract(e, arts) {
  if (arts === undefined) return;
  if (!arts || typeof arts !== 'object' || Array.isArray(arts)) { e('artifacts must be an object'); return; }
  if (arts.provides === undefined) return;
  if (!Array.isArray(arts.provides)) { e('artifacts.provides must be an array'); return; }
  arts.provides.forEach((a, i) => {
    const w = `artifacts.provides[${i}]`;
    if (!a || typeof a !== 'object') { e(`${w} must be an object`); return; }
    for (const k of ['id', 'media_type', 'scope']) {
      if (typeof a[k] !== 'string' || !a[k].trim()) e(`${w}.${k} is required`);
    }
    if (a.access !== 'read-only') e(`${w}.access must be "read-only"（v0 只建立只讀契約）`);
    if (a.retention !== undefined && typeof a.retention !== 'string') e(`${w}.retention must be a string`);
  });
}

// ============================================================
// 029：Package-defined Device Verify（可選）——Package 自己宣告真機驗證 hook
// ============================================================
function validateVerification(e, v) {
  if (v === undefined) return;
  if (!v || typeof v !== 'object' || Array.isArray(v)) { e('verification must be an object'); return; }
  const d = v.device;
  if (d === undefined) return;
  if (!d || typeof d !== 'object' || Array.isArray(d)) { e('verification.device must be an object'); return; }
  if (typeof d.command !== 'string' || !d.command.trim()) e('verification.device.command is required (shell command, cwd=package root)');
  if (d.timeout_ms !== undefined && (!Number.isFinite(d.timeout_ms) || d.timeout_ms <= 0)) e('verification.device.timeout_ms must be a positive number');
  if (d.requires_running !== undefined && typeof d.requires_running !== 'boolean') e('verification.device.requires_running must be boolean');
}

// 030：Package 菜单是 Package 自己页面的唯一声明。v0 只允许它把既有 WebUI 根页挂到一个固定
// 顶层分类下；禁止占 core 路径、伪装其他包、或提前发明通用子页面协议。
function validateMenu(e, packageId, menu) {
  if (menu === undefined) return;
  if (!Array.isArray(menu)) { e('menu must be an array'); return; }
  if (menu.length > 1) e('menu v0 allows one Package root page');
  for (const [index, node] of menu.entries()) {
    const where = `menu[${index}]`;
    if (!node || typeof node !== 'object' || Array.isArray(node)) { e(`${where} must be an object`); continue; }
    if (!PACKAGE_MENU_PARENTS.has(node.parent)) e(`${where}.parent must be one of the core navigation categories`);
    if (node.path !== `/packages/${packageId}/`) e(`${where}.path must be the owning Package WebUI root`);
    if (typeof node.title !== 'string' || !node.title.trim()) e(`${where}.title is required`);
    if (!Number.isFinite(node.order) || node.order < 0) e(`${where}.order must be a non-negative number`);
    if (node.required_package !== undefined) e(`${where}.required_package is derived from the owning Package`);
  }
}

// Package-owned HTTP API ports. A declaration describes intent; the Framework assigns and
// persists the actual port so Packages never compete by guessing a global number.
function validatePorts(e, ports) {
  if (ports === undefined) return;
  if (!Array.isArray(ports)) { e('ports must be an array'); return; }
  const ids = new Set();
  const preferred = new Set();
  ports.forEach((port, i) => {
    const where = `ports[${i}]`;
    if (!port || typeof port !== 'object' || Array.isArray(port)) { e(`${where} must be an object`); return; }
    if (typeof port.id !== 'string' || !PORT_ID_RE.test(port.id)) e(`${where}.id must be lowercase [a-z0-9_-]`);
    else if (ids.has(port.id)) e(`${where}.id must be unique`);
    else ids.add(port.id);
    if (!PORT_PROTOCOLS.has(port.protocol)) e(`${where}.protocol must be one of [${[...PORT_PROTOCOLS].join(', ')}]`);
    if (port.preferred !== undefined
      && (!Number.isInteger(port.preferred) || port.preferred < 1024 || port.preferred > 65535)) {
      e(`${where}.preferred must be an integer from 1024 to 65535`);
    } else if (port.preferred !== undefined) {
      if (preferred.has(port.preferred)) e(`${where}.preferred must be unique within the Package`);
      preferred.add(port.preferred);
    }
    if (port.visibility !== undefined && !PORT_VISIBILITY.has(port.visibility)) {
      e(`${where}.visibility must be one of [${[...PORT_VISIBILITY].join(', ')}]`);
    }
    if (port.health !== undefined && port.health !== null
      && (typeof port.health !== 'string' || !port.health.startsWith('/') || port.health.includes('..'))) {
      e(`${where}.health must be a package-local HTTP path starting with /`);
    }
    if (port.required !== undefined && typeof port.required !== 'boolean') e(`${where}.required must be boolean`);
  });
}

// Public install-time metadata.  The Framework shows this before downloading a
// Package; it is intentionally descriptive and contains no credentials.
function validatePublicMetadata(e, value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    e('public metadata must be an object');
    return;
  }
  const dependencies = value.dependencies;
  if (dependencies !== undefined) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      e('dependencies must be an object');
    } else {
      if (dependencies.framework !== undefined && typeof dependencies.framework !== 'string') {
        e('dependencies.framework must be a string');
      }
      for (const key of ['termux_packages', 'external', 'packages']) {
        if (dependencies[key] !== undefined
          && (!Array.isArray(dependencies[key]) || dependencies[key].some((x) => typeof x !== 'string' || !x.trim()))) {
          e(`dependencies.${key} must be an array of non-empty strings`);
        }
      }
    }
  }
  const security = value.security;
  if (security !== undefined) {
    if (!security || typeof security !== 'object' || Array.isArray(security)) {
      e('security must be an object');
    } else {
      for (const [key, item] of Object.entries(security)) {
        if (typeof item !== 'string'
          && (!Array.isArray(item) || item.some((x) => typeof x !== 'string' || !x.trim()))) {
          e(`security.${key} must be a string or an array of non-empty strings`);
        }
      }
    }
  }
}

/** Manifest 聲明的 target 列表；未聲明 = [generic]（§3.2 向後兼容） */
export function manifestTargets(m) {
  if (!Array.isArray(m?.targets) || m.targets.length === 0) return [{ id: TARGET_GENERIC, os: null, arch: null }];
  return m.targets;
}

/**
 * target 與 device profile 比對（023 §6.2）。
 * generic → 永遠可裝；欄位 unknown → needs_force（不猜）；欄位不合 → mismatch。
 * @returns { ok, verdict: 'match'|'generic'|'mismatch'|'needs_force', reasons[] }
 */
export function matchTarget(target, profile) {
  if (!target || target.id === TARGET_GENERIC) return { ok: true, verdict: 'generic', reasons: [] };
  const reasons = [];
  let unknown = false;
  for (const f of ['os', 'arch', 'htp', 'qnn']) {
    const want = target[f];
    if (want === undefined || want === null) continue; // target 不聲明此維度=不要求
    const got = profile?.[f];
    if (got === undefined || got === null || got === 'unknown') {
      unknown = true;
      reasons.push(`${f}: target wants "${want}", device reports unknown`);
      continue;
    }
    if (String(got).toLowerCase() !== String(want).toLowerCase()) {
      reasons.push(`${f}: target wants "${want}", device has "${got}"`);
    }
  }
  const hard = reasons.filter((r) => !r.includes('unknown'));
  if (hard.length) return { ok: false, verdict: 'mismatch', reasons };
  if (unknown) return { ok: false, verdict: 'needs_force', reasons };
  return { ok: true, verdict: 'match', reasons: [] };
}

export function validateManifest(m, { frameworkVersion } = {}) {
  const errors = [];
  const e = (msg) => errors.push(msg);
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['manifest must be a JSON object'], compatible: true };
  }

  if (m.schema !== MANIFEST_SCHEMA) e(`schema must be "${MANIFEST_SCHEMA}"`);
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) e('id must match github.<owner>.<category>.<name> (lowercase)');
  if (typeof m.name !== 'string' || !m.name.trim()) e('name is required');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) e('version must be x.y.z');
  if (!Array.isArray(m.types) || m.types.length === 0 || m.types.some((t) => !TYPES.has(t))) {
    e(`types must be a non-empty subset of [${[...TYPES].join(', ')}]`);
  }
  if (!relPathOk(m.entrypoints?.backend)) e('entrypoints.backend must be a relative path inside the package');
  if (!relPathOk(m.entrypoints?.webui)) e('entrypoints.webui must be a relative path inside the package');

  if (!m.components || typeof m.components !== 'object') e('components is required');
  else {
    for (const k of ['services', 'actions', 'apps', 'assets']) { // 024：components.assets
      if (m.components[k] !== undefined && !Array.isArray(m.components[k])) e(`components.${k} must be an array`);
    }
  }

  if (!m.capabilities || typeof m.capabilities !== 'object') e('capabilities is required');
  else {
    for (const k of ['provides', 'requires']) {
      if (m.capabilities[k] !== undefined && !Array.isArray(m.capabilities[k])) e(`capabilities.${k} must be an array`);
    }
  }

  validateRuntime(e, m.runtime);   // 023：皆可選，不聲明=legacy
  validateTargets(e, m.targets);   // 023：不聲明=generic
  validateAssets(e, m.assets);     // 024：可選
  validateSession(e, m.session);   // 025：可選（App 的臨時 Session 策略）
  validateVerification(e, m.verification); // 029：可選（Package 自定義真機驗證 hook）
  validateIntegrations(e, m.integrations); // 029：可選（跨組件 capability 宣告）
  validateArtifactsContract(e, m.artifacts); // 029：可選（跨組件只讀 artifact 契約）
  validateMenu(e, m.id, m.menu); // 030：Package-owned navigation，缺省=仅 Package Details
  validatePorts(e, m.ports); // Package-owned HTTP API port contract
  validatePublicMetadata(e, m.public_metadata); // install-time dependencies/security, no secrets

  // components.assets 宣告的 id 必須真有 assets.provides 兌現（聲明 vs 實現一致性，同 021 精神）
  const declaredAssets = m.components?.assets ?? [];
  if (Array.isArray(declaredAssets) && Array.isArray(m.assets?.provides)) {
    const provided = new Set(m.assets.provides.map((a) => a?.id));
    for (const id of declaredAssets) {
      if (!provided.has(id)) e(`components.assets lists "${id}" but assets.provides does not define it`);
    }
  } else if (Array.isArray(declaredAssets) && declaredAssets.length && !m.assets?.provides) {
    e('components.assets is non-empty but assets.provides is missing');
  }

  // 兼容檢查：只支持 ">=x.y.z"；不聲明=不限制
  let compatible = true;
  const compat = m.compatibility?.framework;
  if (compat !== undefined) {
    const mm = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(String(compat));
    if (!mm) e('compatibility.framework must be ">=x.y.z"');
    else if (frameworkVersion) {
      const cur = frameworkVersion.split('.').map(Number);
      const min = mm.slice(1, 4).map(Number);
      compatible = cur[0] !== min[0] ? cur[0] > min[0]
        : cur[1] !== min[1] ? cur[1] > min[1]
        : cur[2] >= min[2];
    }
  }

  return { ok: errors.length === 0, errors, compatible };
}

// ============================================================
// 自檢：node src/packages/manifest.mjs --self-test
// （必須驗證自己是入口模塊：本文件被 loader import，不加判斷會搶跑 loader 的 self-test）
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const base = {
    schema: MANIFEST_SCHEMA, id: 'github.termux-os.fixture.valid', name: 'X', version: '0.1.0',
    types: ['adapter'], entrypoints: { backend: 'package.mjs', webui: 'web/index.html' },
    components: { services: [], actions: [], apps: [] }, capabilities: { provides: [], requires: [] },
  };
  t('valid manifest ok', validateManifest(base).ok);
  t('bad schema rejected', !validateManifest({ ...base, schema: 'v2' }).ok);
  t('bad id rejected', !validateManifest({ ...base, id: 'Foo.Bar' }).ok && !validateManifest({ ...base, id: 'a.b.c' }).ok);
  t('bad version rejected', !validateManifest({ ...base, version: '1.0' }).ok);
  t('bad types rejected', !validateManifest({ ...base, types: ['plugin'] }).ok && !validateManifest({ ...base, types: [] }).ok);
  t('escaping entrypoint rejected', !validateManifest({ ...base, entrypoints: { backend: '../x.mjs', webui: 'web/index.html' } }).ok
    && !validateManifest({ ...base, entrypoints: { backend: '/abs.mjs', webui: 'web/index.html' } }).ok);
  t('missing components rejected', !validateManifest({ ...base, components: undefined }).ok);
  const compat = validateManifest({ ...base, compatibility: { framework: '>=0.2.0' } }, { frameworkVersion: '0.1.0' });
  t('incompatible detected', compat.ok && compat.compatible === false);
  t('compatible passes', validateManifest({ ...base, compatibility: { framework: '>=0.1.0' } }, { frameworkVersion: '0.1.0' }).compatible === true);
  t('bad compatibility syntax rejected', !validateManifest({ ...base, compatibility: { framework: '~0.1.0' } }).ok);
  const packageMenu = [{ parent: '/admin/status', path: `/packages/${base.id}/`, title: 'Example status', order: 40 }];
  t('Package-owned menu root accepted', validateManifest({ ...base, menu: packageMenu }).ok);
  t('Package menu cannot occupy core or another Package path',
    !validateManifest({ ...base, menu: [{ ...packageMenu[0], path: '/admin/status/runtime' }] }).ok
    && !validateManifest({ ...base, menu: [{ ...packageMenu[0], path: '/packages/github.termux-os.service.other/' }] }).ok);
  t('Package menu parent and owner requirement are enforced',
    !validateManifest({ ...base, menu: [{ ...packageMenu[0], parent: '/admin/root' }] }).ok
    && !validateManifest({ ...base, menu: [{ ...packageMenu[0], required_package: base.id }] }).ok);

  // --- 023 runtime contract ---
  const runtime = {
    framework: { commands: ['node', 'python3'] },
    termux_packages: [{ id: 'python-numpy', probe: { type: 'python_import', value: 'numpy' }, required: true }],
    bundled: [{ path: 'service/native/bin/pcm_vad_worker', type: 'executable', required: true }],
    external: [{ id: 'android-app', type: 'adapter', probe: 'android.app.status', required: true }],
  };
  t('runtime contract accepted', validateManifest({ ...base, runtime }).ok);
  t('legacy manifest (no runtime/targets) still ok', validateManifest(base).ok);
  t('bundled escaping path rejected',
    !validateManifest({ ...base, runtime: { bundled: [{ path: '../evil', type: 'file' }] } }).ok
    && !validateManifest({ ...base, runtime: { bundled: [{ path: '/abs', type: 'file' }] } }).ok);
  t('bundled bad type rejected', !validateManifest({ ...base, runtime: { bundled: [{ path: 'a', type: 'blob' }] } }).ok);
  t('bad probe type rejected',
    !validateManifest({ ...base, runtime: { termux_packages: [{ id: 'x', probe: { type: 'curl', value: 'y' } }] } }).ok);
  t('string probe shorthand normalized',
    normalizeProbe('android.app.status').type === 'framework_action'
    && normalizeProbe({ type: 'command', value: 'node' }).value === 'node');

  // --- 023 targets ---
  const targets = [{ id: 'android-arm64-v73-qnn247', os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.47' }];
  t('targets accepted', validateManifest({ ...base, targets }).ok);
  t('reserved target id "generic" rejected',
    !validateManifest({ ...base, targets: [{ id: 'generic', os: 'android', arch: 'arm64' }] }).ok);
  t('bad htp/qnn form rejected',
    !validateManifest({ ...base, targets: [{ id: 'x', os: 'android', arch: 'arm64', htp: '73' }] }).ok
    && !validateManifest({ ...base, targets: [{ id: 'x', os: 'android', arch: 'arm64', qnn: '2.47.0' }] }).ok);
  t('duplicate target id rejected',
    !validateManifest({ ...base, targets: [targets[0], { ...targets[0] }] }).ok);
  t('undeclared targets = generic', manifestTargets(base)[0].id === TARGET_GENERIC);

  // --- 023 target matching ---
  const dev = { os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.47' };
  t('exact target matches', matchTarget(targets[0], dev).verdict === 'match');
  t('generic always installs', matchTarget({ id: TARGET_GENERIC }, dev).ok === true);
  t('htp mismatch refused', matchTarget(targets[0], { ...dev, htp: 'v79' }).verdict === 'mismatch');
  t('qnn mismatch refused', matchTarget(targets[0], { ...dev, qnn: '2.42' }).verdict === 'mismatch');
  t('unknown field needs force (not guessed)',
    matchTarget(targets[0], { ...dev, htp: 'unknown' }).verdict === 'needs_force');
  t('hard mismatch beats unknown',
    matchTarget(targets[0], { ...dev, htp: 'unknown', arch: 'x86_64' }).verdict === 'mismatch');

  // --- 024 assets ---
  const assetProvide = {
    types: ['asset'],
    components: { services: [], actions: [], apps: [], assets: ['model.sensevoice'] },
    assets: { provides: [{ id: 'model.sensevoice', kind: 'model', payload: 'payload/sensevoice',
      files: { context: 'sensevoice.ctx.onnx', metadata: 'asset.json' } }] },
  };
  t('asset package accepted', validateManifest({ ...base, ...assetProvide }).ok);
  t('asset type allowed in types', validateManifest({ ...base, types: ['asset'] }).ok);
  t('assets.requires accepted',
    validateManifest({ ...base, assets: { requires: [{ id: 'model.sensevoice', required: true, target: 'current' }] } }).ok);
  t('declared asset without provider rejected',
    !validateManifest({ ...base, components: { ...base.components, assets: ['model.ghost'] }, assets: { provides: [] } }).ok);
  t('components.assets without assets.provides rejected',
    !validateManifest({ ...base, components: { ...base.components, assets: ['model.x'] } }).ok);
  t('asset payload escaping package rejected',
    !validateManifest({ ...base, ...assetProvide,
      assets: { provides: [{ ...assetProvide.assets.provides[0], payload: '../outside' }] } }).ok);
  t('asset files must be bare filenames',
    !validateManifest({ ...base, ...assetProvide,
      assets: { provides: [{ ...assetProvide.assets.provides[0], files: { model: 'sub/dir/model.onnx' } }] } }).ok);
  t('bad asset kind rejected',
    !validateManifest({ ...base, ...assetProvide,
      assets: { provides: [{ ...assetProvide.assets.provides[0], kind: 'binary' }] } }).ok);
  t('duplicate asset id rejected',
    !validateManifest({ ...base, ...assetProvide,
      components: { ...base.components, assets: ['model.sensevoice'] },
      assets: { provides: [assetProvide.assets.provides[0], { ...assetProvide.assets.provides[0] }] } }).ok);
  t('assets.requires bad target rejected',
    !validateManifest({ ...base, assets: { requires: [{ id: 'x', target: 'v73' }] } }).ok);
  t('legacy manifest without assets still ok', validateManifest(base).ok);

  // --- 025 session ---
  const sess = { required_capabilities: ['speech.transcript', 'speech.speak'],
    quiesce_unrelated_services: true, restore_on_stop: true };
  t('session declaration accepted', validateManifest({ ...base, session: sess }).ok);

  t('manifest without session still ok', validateManifest(base).ok);
  t('session.required_capabilities must be strings',
    !validateManifest({ ...base, session: { required_capabilities: [{ id: 'x' }] } }).ok);
  t('session.quiesce_unrelated_services must be boolean',
    !validateManifest({ ...base, session: { ...sess, quiesce_unrelated_services: 'yes' } }).ok);

  const ports = [{ id: 'http', protocol: 'http', preferred: 9120, visibility: 'loopback', health: '/health' }];
  t('Package HTTP port declaration accepted', validateManifest({ ...base, ports }).ok);
  t('invalid Package port declaration rejected',
    !validateManifest({ ...base, ports: [{ ...ports[0], preferred: 80 }] }).ok
    && !validateManifest({ ...base, ports: [{ ...ports[0], visibility: 'public' }] }).ok
    && !validateManifest({ ...base, ports: [{ ...ports[0], health: '../health' }] }).ok);
  t('public dependency/security metadata accepted', validateManifest({ ...base,
    public_metadata: {
      dependencies: { framework: '>=0.1.6', termux_packages: ['tmux'] },
      security: { permissions: ['network:listen'], network: 'loopback by default' },
    },
  }).ok);
  t('invalid public metadata rejected', !validateManifest({ ...base,
    public_metadata: { dependencies: { termux_packages: [''] } },
  }).ok && !validateManifest({ ...base, public_metadata: { security: { permissions: [3] } } }).ok);

  process.exit(fails ? 1 : 0);
}
