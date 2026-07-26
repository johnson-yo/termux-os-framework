/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/packages/runtime-contract.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeProbe, manifestTargets, matchTarget, TARGET_GENERIC } from './manifest.mjs';

const PROBE_TIMEOUT = 5000; // 023 §1.3

/** 只讀外部命令；取不到一律回 null（調用方轉 unknown），絕不編造 */
function run(cmd, args, timeout = PROBE_TIMEOUT) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

// ============================================================
// Device Profile（023 §6）
// ============================================================

/** 當前設備畫像；任一項取不到=「unknown」（§6.1 不得猜測） */
export function deviceProfile() {
  const soc = process.env.DEVICE_SOC ?? run('getprop', ['ro.soc.model']) ?? null;
  const isAndroid = !!run('getprop', ['ro.build.version.sdk']);
  const uname = run('uname', ['-m']);
  const arch = uname === 'aarch64' ? 'arm64' : (uname ?? 'unknown');
  const py = run('python3', ['--version']);
  return {
    os: isAndroid ? 'android' : (process.platform || 'unknown'),
    arch,
    soc: soc || 'unknown',
    htp: process.env.DEVICE_HTP ?? 'unknown',
    qnn: process.env.DEVICE_QNN ?? 'unknown',
    python: /(\d+\.\d+)\.\d+/.exec(py ?? '')?.[1] ?? 'unknown',
  };
}

/** Release target 選擇：Manifest 聲明的 targets 中挑一個能裝的（§6.2） */
export function resolveTarget(manifest, profile) {
  const targets = manifestTargets(manifest);
  const results = targets.map((t) => ({ target: t, ...matchTarget(t, profile) }));
  return results.find((r) => r.verdict === 'match')
    ?? results.find((r) => r.verdict === 'generic')
    ?? results.find((r) => r.verdict === 'needs_force')
    ?? results[0];
}

export const archiveName = (id, version, targetId) => (targetId && targetId !== TARGET_GENERIC
  ? `${id}-${version}-${targetId}.tar.gz`
  : `${id}-${version}.tar.gz`);

// ============================================================
// ELF 檢查（023 §4.3）
// ============================================================

const RUNPATH_RE = /\(R(?:UN)?PATH\)\s+Library r(?:un)?path:\s+\[([^\]]*)\]/;

export function inspectElf(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'file not found' };
  const head = run('readelf', ['-h', file]);
  if (!head) return { ok: false, error: 'readelf failed (not an ELF?)' };
  const arch = /Machine:\s+(.+)/.exec(head)?.[1]?.trim() ?? 'unknown';
  const dyn = run('readelf', ['-d', file]) ?? '';
  const runpath = (RUNPATH_RE.exec(dyn)?.[1] ?? '').split(':').filter(Boolean);
  const needed = [...dyn.matchAll(/\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/g)].map((m) => m[1]);
  return { ok: true, arch, runpath, needed };
}

/**
 * RUNPATH 紅線（§4.1）。要守住的不變式是**包自己的 .so 必須解析到包內副本**，於是：
 *  1. 第一個條目必須是 $ORIGIN 相對——Termux 的 clang 驅動硬塞 `-rpath=$PREFIX/lib`
 *     且排在前面，若不重排，宿主機同名 .so 會蓋過包內副本（patchelf 重排，見 native/Makefile）。
 *  2. 任何條目都不許釘 python 小版本——真機事故：RUNPATH 寫死 python3.13，換到 python3.14
 *     的機器連 `pip install kaldi-native-fbank` 都救不了。
 *  3. 開發機路徑一律拒。
 * $PREFIX/lib 這類平台運行時路徑（libc++_shared.so 的家，與 libc 同級）排在 $ORIGIN 之後可接受——
 * 它不是本包的依賴，刪掉反而讓 binary 起不來。
 */
export const PLATFORM_LIB_RE = /^\/data\/data\/com\.termux\/files\/usr\/lib\/?$/;

/**
 * @param needsBundled 此 ELF 的 NEEDED 裡是否含本包自帶的 .so。
 *   排序規則只在**有東西可被遮蔽時**才有意義：Termux clang 給每個產物都塞 $PREFIX/lib，
 *   對一個不依賴任何包內 .so 的葉子庫（如 libkaldi 自己）強求 $ORIGIN 開頭是無的放矢。
 */
export function checkRunpath(runpath, { needsBundled = true } = {}) {
  const bad = [];
  // Termux 驅動塞的是未規範化的 .../bin/../../usr/lib，須先化簡再判定
  const norm = (p) => (p.startsWith('$ORIGIN') ? p : path.posix.normalize(p));
  if (needsBundled && runpath.length && !runpath[0].startsWith('$ORIGIN')) {
    bad.push(`RUNPATH must start with an $ORIGIN-relative entry so bundled libs win; got "${runpath[0]}" first`);
  }
  for (const p of runpath) {
    const n = norm(p);
    if (/python3\.\d+/.test(n)) bad.push(`RUNPATH "${p}" pins a python minor version`);
    else if (/^\/mnt\//.test(n)) bad.push(`RUNPATH "${p}" points at a developer machine path`);
    else if (!n.startsWith('$ORIGIN') && !PLATFORM_LIB_RE.test(n)) {
      bad.push(`RUNPATH "${p}" is an absolute path outside the package and is not the Termux platform lib dir`);
    }
  }
  return bad;
}

// ============================================================
// Bundled artifact 檢查（023 §5.1；pack/verify/check 三處共用）
// ============================================================

/** target 的 arch → readelf 的 Machine 字串。表外 arch = 不檢查（不猜） */
export const ARCH_MACHINE = {
  arm64: /AArch64/i,
  x86_64: /X86-64/i,
};

export function checkBundled(pkgDir, manifest) {
  const decl = manifest?.runtime?.bundled;
  if (!Array.isArray(decl) || decl.length === 0) return { ok: true, declared: false, items: [] };
  // ELF 架構的期望值來自 **target**，不是寫死的常數——Release 是給某個 target 打的
  const wantArch = manifestTargets(manifest)[0]?.arch;
  const machineRe = ARCH_MACHINE[wantArch] ?? null;

  const bundledNames = new Set(decl
    .filter((d) => d.type === 'shared_library')
    .map((d) => path.basename(d.path)));

  const items = decl.map((d) => {
    const required = d.required !== false;
    const abs = path.join(pkgDir, d.path);
    const item = { path: d.path, type: d.type, required, ok: false, reason: null };
    if (!fs.existsSync(abs)) {
      item.reason = `missing from package (expected at "${d.path}")`;
      return item;
    }
    const st = fs.statSync(abs);
    if (!st.isFile()) { item.reason = 'not a regular file'; return item; }

    if (d.type === 'executable' && !(st.mode & 0o111)) { item.reason = 'not executable (mode bit missing)'; return item; }

    if (d.type === 'executable' || d.type === 'shared_library') {
      const elf = inspectElf(abs);
      if (!elf.ok) { item.reason = elf.error; return item; }
      if (machineRe && !machineRe.test(elf.arch)) {
        item.reason = `arch is "${elf.arch}", target "${manifestTargets(manifest)[0]?.id}" wants ${wantArch}`;
        return item;
      }
      const needsBundled = elf.needed.some((n) => bundledNames.has(n));
      const bad = checkRunpath(elf.runpath, { needsBundled });
      if (bad.length) { item.reason = bad.join('; '); return item; }
      item.runpath = elf.runpath;
      // NEEDED 中屬於本包的 .so 必須真的隨包（§4.3）——這正是 libkaldi 事故的檢出點
      const missingDeps = elf.needed.filter((n) => bundledNames.has(n)
        && !decl.some((o) => path.basename(o.path) === n && fs.existsSync(path.join(pkgDir, o.path))));
      if (missingDeps.length) { item.reason = `NEEDED package library not bundled: ${missingDeps.join(', ')}`; return item; }
      item.needed = elf.needed;
    }
    item.ok = true;
    return item;
  });

  const ok = items.every((i) => i.ok || !i.required);
  return { ok, declared: true, items };
}

// ============================================================
// External / Termux package 探測（023 §2.3、§9）
// ============================================================

function runProbe(probe, ctx = {}) {
  const p = normalizeProbe(probe);
  if (!p) return { ok: false, reason: 'invalid probe' };
  switch (p.type) {
    case 'command': {
      const hit = run('sh', ['-c', `command -v ${JSON.stringify(p.value)}`]);
      return hit ? { ok: true } : { ok: false, reason: `command not found: ${p.value}` };
    }
    case 'file':
      return fs.existsSync(p.value) ? { ok: true } : { ok: false, reason: `file not found: ${p.value}` };
    case 'python_import': {
      const hit = run('python3', ['-c', `import ${p.value}`]);
      return hit === null ? { ok: false, reason: `python import ${p.value} failed` } : { ok: true };
    }
    case 'framework_action':
      // Framework 內的能力探測需要運行中的 Core；CLI 側不起 Framework，故如實回報「未探測」
      // 而不是假裝通過（ctx.actionProbe 由 Core 注入時才真探）
      return ctx.actionProbe ? ctx.actionProbe(p.value) : { ok: null, reason: 'not probed (framework not running)' };
    default:
      return { ok: false, reason: `unsupported probe type: ${p.type}` };
  }
}

export function checkExternal(manifest, ctx = {}) {
  const out = [];
  for (const key of ['termux_packages', 'external']) {
    for (const item of manifest?.runtime?.[key] ?? []) {
      const required = item.required !== false;
      const r = runProbe(item.probe, ctx);
      out.push({ id: item.id, kind: key, required, ok: r.ok, reason: r.ok === true ? null : r.reason });
    }
  }
  const cmds = manifest?.runtime?.framework?.commands ?? [];
  for (const c of cmds) {
    const hit = run('sh', ['-c', `command -v ${JSON.stringify(c)}`]);
    out.push({ id: c, kind: 'framework', required: true, ok: !!hit, reason: hit ? null : `command not found: ${c}` });
  }
  const ok = out.every((i) => i.ok === true || !i.required || i.ok === null);
  return { ok, items: out };
}

// ============================================================
// 禁止路徑掃描（023 §5.3）
// ============================================================

export const FORBIDDEN_PATTERNS = [
  { re: /\/(?:home|Users)\/[^/\s"']+\//, why: 'developer machine path' },
  { re: /[A-Za-z]:\\Users\\/, why: 'developer machine path' },
  { re: /termux-stts/, why: 'donor project reference' },
  { re: /framework\/packages\//, why: 'source tree path (runtime loads from installed root)' },
  { re: /files\/usr\/lib\/python3\.\d+/, why: 'pinned python minor version path' },
];

const TEXT_EXT = /\.(mjs|js|py|json|html|css|sh|h|hpp|cpp|c|mk|Makefile)$/i;

/** 掃文本；ELF 的 RUNPATH 由 checkBundled 管（二進制不做全文掃描，誤報太多） */
export function scanForbiddenPaths(dir, relBase = '') {
  const bad = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.join(relBase, e.name);
    if (e.isDirectory()) { bad.push(...scanForbiddenPaths(p, rel)); continue; }
    if (/\.(md|txt)$/i.test(e.name)) continue;                       // 說明文檔豁免（NOTICE 需提及來源）
    if (!TEXT_EXT.test(e.name) && e.name !== 'Makefile') continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      for (const f of FORBIDDEN_PATTERNS) {
        if (f.re.test(line)) bad.push(`${rel}: ${f.why} — ${line.trim().slice(0, 100)}`);
      }
    }
  }
  return bad;
}

// ============================================================
// 029 §12：Integration Contract——跨組件 API 按 capability 判定；探不到（無 Framework）如實 null。
// 與 runtime.external 相反，integration 默認 optional：跨組件 API 多是增強，缺了該 degraded 不該死
// ============================================================
export function checkIntegrations(manifest, ctx = {}) {
  const items = [];
  for (const item of manifest?.integrations?.requires ?? []) {
    const required = item.required === true;
    const r = ctx.integrationProbe
      ? ctx.integrationProbe(item.capability)
      : { ok: null, reason: 'not probed (framework not running)' };
    items.push({ capability: item.capability, required, ok: r.ok,
      reason: r.ok === true ? null : r.reason,
      degraded_behavior: item.degraded_behavior ?? null });
  }
  const ok = items.every((i) => i.ok === true || !i.required || i.ok === null);
  return { ok, items };
}

// ============================================================
// Preflight 匯總（023 §9；029 併入 integrations）
// ============================================================

export function preflight(pkgDir, manifest, { profile = deviceProfile(), force = false, ctx = {} } = {}) {
  const bundled = checkBundled(pkgDir, manifest);
  const external = checkExternal(manifest, ctx);
  const integrations = checkIntegrations(manifest, ctx);
  const t = resolveTarget(manifest, profile);
  const targetOk = t.ok || (force && t.verdict === 'needs_force');
  return {
    ok: bundled.ok && external.ok && integrations.ok && targetOk,
    bundled,
    external: external.items,
    integrations: integrations.items,
    target: {
      ok: targetOk, verdict: t.verdict, id: t.target?.id ?? TARGET_GENERIC,
      current: profile, reasons: t.reasons ?? [],
    },
  };
}

// ============================================================
// 自檢：node src/packages/runtime-contract.mjs --self-test
// （被 import 時必須驗證自己是入口模塊，否則搶跑對方 self-test）
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-self-'));
  const mk = (rel, content = 'x', mode) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (mode) fs.chmodSync(p, mode);
    return p;
  };

  // --- bundled ---
  const mfNone = { runtime: {} };
  t('no bundled declared = ok, declared:false', checkBundled(tmp, mfNone).ok && !checkBundled(tmp, mfNone).declared);

  const mfMissing = { targets: [{ id: 'android-arm64-v73-qnn247', os: 'android', arch: 'arm64' }],
    runtime: { bundled: [{ path: 'service/native/bin/w', type: 'executable', required: true }] } };
  const rMissing = checkBundled(tmp, mfMissing);
  t('missing required artifact fails', !rMissing.ok && /missing from package/.test(rMissing.items[0].reason));

  mk('service/native/bin/w', 'not an elf', 0o644);
  t('non-executable mode fails', /not executable/.test(checkBundled(tmp, mfMissing).items[0].reason));
  fs.chmodSync(path.join(tmp, 'service/native/bin/w'), 0o755);
  t('non-ELF fails', !checkBundled(tmp, mfMissing).ok);

  // ELF 架構期望值跟隨 target：同一個檔案在 x86_64 target 下合格、在 arm64 target 下不合格
  fs.copyFileSync('/bin/true', path.join(tmp, 'service/native/bin/w'));
  fs.chmodSync(path.join(tmp, 'service/native/bin/w'), 0o755);
  t('host-arch ELF rejected for arm64 target', /arch is/.test(checkBundled(tmp, mfMissing).items[0].reason ?? ''));
  const mfX86 = { ...mfMissing, targets: [{ id: 'linux-x86-64', os: 'linux', arch: 'x86_64' }] };
  t('same ELF accepted for its own target', checkBundled(tmp, mfX86).ok);
  const mfNoArch = { ...mfMissing, targets: [{ id: 'weird', os: 'plan9', arch: 'sparc64' }] };
  t('unknown target arch skips arch check (no guessing)', checkBundled(tmp, mfNoArch).ok);

  const mfOpt = { runtime: { bundled: [{ path: 'nope', type: 'file', required: false }] } };
  t('optional missing artifact tolerated', checkBundled(tmp, mfOpt).ok);

  mk('data/model.bin');
  t('plain file artifact ok', checkBundled(tmp, { runtime: { bundled: [{ path: 'data/model.bin', type: 'file' }] } }).ok);

  // --- runpath ---
  t('$ORIGIN runpath ok', checkRunpath(['$ORIGIN/../lib']).length === 0);
  t('$ORIGIN first + platform lib after ok',
    checkRunpath(['$ORIGIN/../lib', '/data/data/com.termux/files/usr/lib']).length === 0);
  t('platform lib BEFORE $ORIGIN rejected (host lib would shadow bundled)',
    checkRunpath(['/data/data/com.termux/files/usr/lib', '$ORIGIN/../lib']).length === 1);
  t('unnormalized termux platform path accepted',
    checkRunpath(['$ORIGIN/../lib', '/data/data/com.termux/files/usr/bin/../../usr/lib']).length === 0);
  t('leaf lib without bundled deps needs no $ORIGIN first',
    checkRunpath(['/data/data/com.termux/files/usr/bin/../../usr/lib'], { needsBundled: false }).length === 0);
  t('foreign absolute runpath rejected', checkRunpath(['$ORIGIN/../lib', '/opt/random/lib']).length === 1);
  t('python-pinned runpath rejected', checkRunpath(['$ORIGIN/../../lib/python3.13/site-packages']).length === 1);
  t('dev machine runpath rejected', checkRunpath(['$ORIGIN/../lib', ['', 'home', 'developer', 'private', 'lib'].join('/')]).length === 1);

  // --- forbidden paths ---
  mk('svc/bad.py', `P = ${JSON.stringify(['', 'home', 'developer', 'private', 'project'].join('/'))}\n`);
  mk('svc/ok.py', 'P = "./relative"\n');
  mk('svc/note.md', `development happened in ${['', 'home', 'developer', 'private'].join('/')}\n`);
  const scanned = scanForbiddenPaths(tmp);
  t('forbidden dev path detected', scanned.some((s) => s.includes('bad.py')));
  t('markdown exempt from scan', !scanned.some((s) => s.includes('note.md')));
  t('clean file not flagged', !scanned.some((s) => s.includes('ok.py')));

  // --- device profile ---
  const prof = deviceProfile();
  t('profile always has all keys', ['os', 'arch', 'soc', 'htp', 'qnn', 'python']
    .every((k) => typeof prof[k] === 'string' && prof[k].length > 0));
  t('unknown soc yields unknown htp (no guessing)',
    (() => { const s = process.env.DEVICE_SOC; const h = process.env.DEVICE_HTP;
      process.env.DEVICE_SOC = 'SM0000'; delete process.env.DEVICE_HTP;
      const p = deviceProfile(); if (s === undefined) delete process.env.DEVICE_SOC; else process.env.DEVICE_SOC = s;
      if (h !== undefined) process.env.DEVICE_HTP = h;
      return p.htp === 'unknown' && p.soc === 'SM0000'; })());

  // --- archive naming ---
  t('generic archive name has no target suffix',
    archiveName('a.b.c.d', '1.0.0', TARGET_GENERIC) === 'a.b.c.d-1.0.0.tar.gz');
  t('targeted archive name carries target id',
    archiveName('a.b.c.d', '1.0.0', 'android-arm64-v73-qnn247') === 'a.b.c.d-1.0.0-android-arm64-v73-qnn247.tar.gz');

  // --- external probes ---
  const ext = checkExternal({ runtime: { framework: { commands: ['sh'] },
    termux_packages: [{ id: 'ghost', probe: { type: 'command', value: 'definitely-not-a-real-cmd-xyz' }, required: true }] } });
  t('missing required external fails with reason',
    !ext.ok && ext.items.some((i) => i.id === 'ghost' && i.ok === false && /not found/.test(i.reason)));
  t('present framework command passes', ext.items.some((i) => i.id === 'sh' && i.ok === true));
  const extOpt = checkExternal({ runtime: { external: [{ id: 'x', probe: { type: 'file', value: '/nope/nope' }, required: false }] } });
  t('optional external missing does not fail', extOpt.ok);
  const extAct = checkExternal({ runtime: { external: [{ id: 'a', probe: 'android.app.status', required: true }] } });
  t('unprobed framework_action reports null, not fake pass', extAct.items[0].ok === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
