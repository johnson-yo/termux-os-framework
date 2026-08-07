/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: scripts/package-manager.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MANIFEST_FILENAME, validateManifest, manifestTargets, matchTarget, TARGET_GENERIC } from '../src/packages/manifest.mjs';
import { declaredDependencies } from '../src/packages/dependencies.mjs';
import { checkFreeSpace, fetchAssetFiles, pendingBytes } from '../src/assets/fetch.mjs';
import {
  checkBundled, checkExternal, deviceProfile, resolveTarget, archiveName, scanForbiddenPaths, preflight,
  RELEASE_EXCLUDED_NAMES, RELEASE_EXCLUDED_SUFFIXES,
} from '../src/packages/runtime-contract.mjs';
// sha256File 用串流版（024）：舊的 readFileSync 版會把 450MB 的 tar 整個吃進記憶體——手機上會 OOM
import {
  sharedStore, assetVersionDir, sha256File, activateAsset, deactivateAsset, readRegistry,
} from '../src/assets/registry.mjs';
import { defaultAuthFile, readAuthFile } from '../src/system/auth-file.mjs';
import { checkPackagePorts, configurePortRegistry } from '../src/system/port-registry.mjs';
import { packageGitState, packageGitIdentity, describeGitState, GIT_STATE } from '../src/packages/git-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAMEWORK_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
const RELEASES = path.join(ROOT, 'dist/releases');

// 原始 Release 归档的落点，与 versions/ 和 config/ 平行——都在 Git 工作树之外。
// 这是「恢复正式态」唯一可信的来源：active.json 的 hashes 记得住身份，记不住内容。
const ARCHIVE_DIRNAME = 'archive';
const archiveDir = (pkgDir) => path.join(pkgDir, ARCHIVE_DIRNAME);
const archiveKey = (version, target) => `${version}@${target ?? TARGET_GENERIC}`;
const archiveTarPath = (pkgDir, version, target) => path.join(archiveDir(pkgDir), `${archiveKey(version, target)}.tar.gz`);
const archiveMetaPath = (pkgDir, version, target) => path.join(archiveDir(pkgDir), `${archiveKey(version, target)}.json`);
const CONFIG_FOR_PORTS = process.env.FRAMEWORK_CONFIG || process.env.CONFIG || null;
const PORT_REGISTRY_FILE = process.env.PORT_REGISTRY_PATH || (CONFIG_FOR_PORTS
  ? path.join(path.dirname(path.resolve(CONFIG_FOR_PORTS)), '..', 'ports.v1.json') : null);
configurePortRegistry({
  path: PORT_REGISTRY_FILE,
  corePort: Number(process.env.FRAMEWORK_PORT || process.env.PORT) || 8980,
  reserved: [8796, 8797],
  start: Number(process.env.PACKAGE_PORT_START) || 9000,
  end: Number(process.env.PACKAGE_PORT_END) || 9999,
});

const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

// Release 排除項（022 §5.2）；Package 自帶 fixtures 顯式保留
// 029 §6.3：.sdk/（易變開發狀態）與 HANDOFF.md（易變交接）不進不可變 archive——
// mutable 交接更新不再改 release hash；payload 文檔只留 README/RELEASE_NOTES
// 判準的唯一真相源在 runtime-contract.mjs：pack 剝什麼、doctor 就不該因什麼而拒絕。
const EXCLUDES = RELEASE_EXCLUDED_NAMES;
const EXCLUDE_SUFFIX = RELEASE_EXCLUDED_SUFFIXES;
// 禁止路徑判準的唯一真相源 = runtime-contract.mjs 的 FORBIDDEN_PATTERNS（023 §5.3 起併入，
// 避免 pack 查一套、verify 查另一套）

function readPublicAllowlist(src) {
  const file = path.join(src, 'public-files.txt');
  if (!fs.existsSync(file)) return null;
  const entries = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) die(`duplicate package public allowlist entry: ${entry}`);
    if (path.isAbsolute(entry) || entry.split('/').includes('..')) {
      die(`unsafe package public allowlist entry: ${entry}`);
    }
    const source = path.join(src, entry);
    if (!source.startsWith(`${src}${path.sep}`) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      die(`package public allowlist file is missing: ${entry}`);
    }
    seen.add(entry);
  }
  return entries;
}

function copyPackageTree(src, dst, allowlist = null) {
  fs.mkdirSync(dst, { recursive: true });
  if (allowlist) {
    for (const entry of allowlist) {
      const from = path.join(src, entry);
      const to = path.join(dst, entry);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.lstatSync(from).isSymbolicLink()) die(`symlink not allowed in package: ${from}`);
      fs.copyFileSync(from, to);
    }
    return;
  }
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDES.includes(e.name) || EXCLUDE_SUFFIX.some((s) => e.name.endsWith(s))) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isSymbolicLink()) die(`symlink not allowed in package: ${from}`);
    if (e.isDirectory()) copyPackageTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * runtime.bundled 缺項報告（023 §5.1）。
 * 022 的教訓：pack 只查 README/入口，於是 --artifact-dir 布局放錯（要鏡像包內相對路徑，
 * 卻放成根層）時 pack 照樣成功 → sha256 通過 → install 成功 → **運行時才 FileNotFoundError**。
 * 一個跑不起來的包能一路通過整條閉環，比裝不上更糟。故此處是唯一真相源：Manifest 說要什麼，
 * 就必須真的在包裡、類型對、架構對、RUNPATH 乾淨。
 */
function reportBundled(staging, manifest, { hintArtifacts = false } = {}) {
  const r = checkBundled(staging, manifest);
  if (r.ok) return r;
  const lines = r.items.filter((i) => !i.ok && i.required).map((i) => `  ${i.path} [${i.type}]: ${i.reason}`);
  let msg = `release is missing required runtime artifacts (manifest runtime.bundled):\n${lines.join('\n')}`;
  if (hintArtifacts) {
    msg += '\n\n--artifact-dir must MIRROR the package-internal relative path, e.g.\n'
      + `  <artifact-dir>/${r.items.find((i) => !i.ok && i.required)?.path ?? 'service/native/bin/tool'}\n`
      + '  (not <artifact-dir>/tool)';
  }
  die(msg);
}

/** Release 要打哪個 target：--target 顯式指定，須是 Manifest 聲明過的（§7） */
function pickPackTarget(manifest, args) {
  const ti = args.indexOf('--target');
  const declared = manifestTargets(manifest);
  if (ti < 0) {
    if (declared.length > 1) {
      die(`package declares ${declared.length} targets (${declared.map((t) => t.id).join(', ')}); `
        + 'pick one with --target <target-id> — a Release is identified by id+version+target (023 §7.1)');
    }
    return declared[0];
  }
  const want = args[ti + 1];
  const hit = declared.find((t) => t.id === want);
  if (!hit) die(`--target ${want} is not declared in manifest.targets (${declared.map((t) => t.id).join(', ')})`);
  return hit;
}

// ============================================================
// pack <package-id> [--target <id>] [--artifact-dir <path>] [--source <dir>]（開發機）
// ============================================================
async function cmdPack(id, args) {
  const si = args.indexOf('--source');
  const srcDir = si >= 0 ? path.resolve(args[si + 1]) : path.join(ROOT, 'packages', id);
  if (!fs.existsSync(path.join(srcDir, MANIFEST_FILENAME))) die(`source package not found: ${srcDir}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, MANIFEST_FILENAME), 'utf8'));
  const v = validateManifest(manifest, { frameworkVersion: FRAMEWORK_VERSION });
  if (!v.ok) die(`manifest invalid: ${v.errors.join('; ')}`);
  if (manifest.id !== id) die(`manifest id ${manifest.id} != ${id}`);
  const version = manifest.version;
  const target = pickPackTarget(manifest, args);

  // staging：乾淨複製 + 顯式 artifact 注入（鏡像包內相對路徑）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-pack-'));
  const staging = path.join(tmp, id);
  const allowlist = readPublicAllowlist(srcDir);
  copyPackageTree(srcDir, staging, allowlist);
  const ai = args.indexOf('--artifact-dir');
  if (ai >= 0) {
    const adir = args[ai + 1];
    if (!adir || !fs.existsSync(adir)) die(`--artifact-dir not found: ${adir}`);
    fs.cpSync(adir, staging, { recursive: true });
    console.log(`artifacts merged from ${adir}`);
  }

  // Release 只帶自己那一個 target（§7.1：身份=id+version+target；一 tar 一機型）
  if (target.id !== TARGET_GENERIC) {
    fs.writeFileSync(path.join(staging, MANIFEST_FILENAME),
      `${JSON.stringify({ ...manifest, targets: [target] }, null, 2)}\n`);
  }

  for (const f of ['README.md', 'NOTICE.md', 'LICENSE', 'AGENTS.md', manifest.entrypoints.backend, manifest.entrypoints.webui]) {
    if (!fs.existsSync(path.join(staging, f))) die(`release missing required file: ${f}`);
  }
  reportBundled(staging, manifest, { hintArtifacts: true });     // 023 §5.1
  const bad = scanForbiddenPaths(staging);                       // 023 §5.3
  if (bad.length) die(`forbidden content in release:\n  ${bad.join('\n  ')}`);

  const outDir = path.join(RELEASES, id, version);
  fs.mkdirSync(outDir, { recursive: true });
  const tarName = archiveName(id, version, target.id);
  const tarPath = path.join(outDir, tarName);
  // 024 §2：確定性歸檔——相同輸入必產出相同位元組。
  // 曾經用 `tar -czf`：mtime/uid/gname/gzip header 隨構建機與時刻變 → 同一份源碼重打包就換 sha
  // → 撞上「同 version 同 target 不同 hash 一律拒」→ **同版本重打包後裝不回去**。
  // executable 的 mode 由 Manifest 宣告決定，不看 staging 裡碰巧是什麼權限。
  const execs = (manifest.runtime?.bundled ?? [])
    .filter((b) => b.type === 'executable')
    .flatMap((b) => ['--exec', b.path]);
  execFileSync('python3', [path.join(ROOT, 'scripts/reproducible-archive.py'),
    '--root', tmp, '--top', id, '--out', tarPath, ...execs], { stdio: ['ignore', 'inherit', 'inherit'] });

  const digest = sha256File(tarPath);
  fs.writeFileSync(`${tarPath}.sha256`, `${digest}  ${tarName}\n`);

  // 解壓自檢：verify 同一套邏輯
  const r = await verifyArchive(tarPath, `${tarPath}.sha256`);
  if (!r.ok) die(`self-check after pack failed: ${r.error}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`packed ${id} ${version} [target ${target.id}]`);
  console.log(`  ${tarPath}`);
  console.log(`  sha256 ${digest}`);
}

// ============================================================
// verify <tar> <sha256>（只讀；install 前置共用）
// ============================================================
async function verifyArchive(tarPath, shaPath, options = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!fs.existsSync(tarPath)) return fail(`tar not found: ${tarPath}`);
  // 保存下来的原包没有 sidecar：它的期望值来自 active.json 记下的那一个。
  const explicit = options.expectedSha256 ?? null;
  if (!explicit && !fs.existsSync(shaPath)) return fail(`sha256 sidecar not found: ${shaPath}`);

  const expected = explicit ?? fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
  const actual = sha256File(tarPath);
  if (!/^[0-9a-f]{64}$/.test(expected)) return fail('sha256 sidecar malformed');
  if (expected !== actual) return fail(`checksum mismatch: expected ${expected}, got ${actual}`);

  // 路徑安全（022 §4）：單一頂層、無絕對/../、無鏈接・設備・FIFO。
  // A public source archive (for example a GitHub generated tarball) may use
  // an upstream root name such as `<repo>-<version>`, so the Manifest ID is
  // the Package identity and the single top-level directory is only the
  // extraction root. Install normalizes that root before activation.
  let listing;
  try { listing = execFileSync('tar', ['-tvzf', tarPath], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }); }
  catch (e) { return fail(`tar unreadable: ${String(e?.message ?? e)}`); }
  const tops = new Set();
  for (const line of listing.split('\n').filter(Boolean)) {
    const mode = line.trim()[0];
    // GNU tar -tv（LC_ALL=C）：mode owner size date time name[ -> target]
    const name = line.trim().split(/\s+/).slice(5).join(' ').split(' -> ')[0];
    if (!name) continue;
    if ('lbcps'.includes(mode)) return fail(`forbidden entry type "${mode}": ${name}`);
    if (line.includes(' link to ')) return fail(`hardlink forbidden: ${name}`);
    if (name.startsWith('/')) return fail(`absolute path: ${name}`);
    if (name.split('/').includes('..')) return fail(`path escape: ${name}`);
    tops.add(name.split('/')[0]);
  }
  if (tops.size !== 1) return fail(`archive must have exactly one top-level directory, got: ${[...tops].join(', ')}`);
  const topId = [...tops][0];
  if (!topId || topId === '.' || topId === '..' || topId.includes('\\') || topId.includes('\0')) {
    return fail(`unsafe top-level directory: ${topId || '(empty)'}`);
  }

  // 解壓臨時目錄驗 Manifest 與入口
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-verify-'));
  try {
    execFileSync('tar', ['-xzf', tarPath, '-C', tmp]);
    const dir = path.join(tmp, topId);
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) return fail('manifest missing in archive');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const v = validateManifest(manifest, { frameworkVersion: FRAMEWORK_VERSION });
    if (!v.ok) return fail(`manifest invalid: ${v.errors.join('; ')}`);
    if (!v.compatible) return fail(`incompatible: requires framework ${manifest.compatibility?.framework}, current ${FRAMEWORK_VERSION}`);
    if (!fs.existsSync(path.join(dir, manifest.entrypoints.backend))) return fail(`backend missing: ${manifest.entrypoints.backend}`);
    if (!fs.existsSync(path.join(dir, manifest.entrypoints.webui))) return fail(`webui missing: ${manifest.entrypoints.webui}`);
    try { // backend 可載入（不 register）
      const mod = await import(pathToFileURL(path.join(dir, manifest.entrypoints.backend)).href);
      if (typeof mod.register !== 'function') return fail('backend must export register()');
    } catch (e) { return fail(`backend import failed: ${String(e?.message ?? e)}`); }
    // 023 §5.2：verify 在**解壓後的 archive 內**重跑 runtime 契約——pack 通過不代表可跳過。
    // pack 在開發機、verify/install 在目標機，中間隔著傳輸與時間，只有這裡看到的才是要裝的東西。
    const rb = checkBundled(dir, manifest);
    if (!rb.ok) {
      const lines = rb.items.filter((i) => !i.ok && i.required).map((i) => `  ${i.path}: ${i.reason}`);
      return fail(`archive missing required runtime artifacts:\n${lines.join('\n')}`);
    }
    const forbidden = scanForbiddenPaths(dir);
    if (forbidden.length) return fail(`forbidden paths in archive:\n  ${forbidden.slice(0, 10).join('\n  ')}`);
    const targets = manifestTargets(manifest);
    if (targets.length !== 1) return fail(`archive must declare exactly one target, got ${targets.length} (pack with --target)`);

    return {
      ok: true, id: manifest.id, version: manifest.version, sha256: actual, manifest,
      top_id: topId,
      target: targets[0], bundled: rb,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function cmdVerify(tarPath, shaPath) {
  const r = await verifyArchive(tarPath, shaPath ?? `${tarPath}.sha256`);
  if (!r.ok) die(r.error);
  console.log(`OK ${r.id} ${r.version} [target ${r.target.id}]`);
  console.log(`  sha256 ${r.sha256}`);
  if (r.bundled.declared) console.log(`  runtime artifacts: ${r.bundled.items.length} declared, all present`);
}

// ============================================================
// Installed Root 側（在目標機執行；node+tar in Termux）
// ============================================================
import { installedRoot, ACTIVE_FILENAME, ACTIVE_SCHEMA } from '../src/packages/installed-root.mjs';

// Framework 控制面：token 讀運行配置；framework 不在時各操作降級為純文件系統動作
function frameworkApi() {
  const confPath = process.env.CONFIG || '/sdcard/termux-os/framework/conf/framework.v1.json';
  let token = process.env.TERMUX_OS_TOKEN || null;
  if (!token) {
    try { token = readAuthFile(process.env.FRAMEWORK_AUTH_FILE || defaultAuthFile()).admin_token; }
    catch { /* A remote or legacy installation may keep credentials elsewhere. */ }
  }
  if (!token) {
    try { token = JSON.parse(fs.readFileSync(confPath, 'utf8')).auth?.admin_token ?? null; }
    catch { /* Legacy configuration is optional. */ }
  }
  const base = process.env.FRAMEWORK_BASE_URL || 'http://127.0.0.1:8980';
  const call = async (method, p) => {
    try {
      const r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
      return await r.json();
    } catch { return null; } // framework 不在 = null
  };
  return { call, up: async () => { try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } } };
}

const sh = (cmd2, args2) => execFileSync(cmd2, args2, { encoding: 'utf8' });
const frameworkRestart = () => {
  const fw = path.join(os.homedir(), 'framework.sh');
  if (!fs.existsSync(fw)) return false;
  try { sh('bash', [fw, 'restart']); return true; } catch { try { sh('bash', [fw, 'start']); return true; } catch { return false; } }
};

/**
 * 等這個包在重啟後的 Framework 裡報出狀態。
 *
 * ⚠ 這個窗口必須從**服務回來的那一刻**開始算，而不是從重啟命令發出時算。此前是一個
 * 固定的 30 秒，於是一台裝了 8 個包、啟動要 40 秒的設備上，每一次安裝都會在服務還沒
 * 起完時判定失敗、回滾一個其實裝好了的版本——而錯誤訊息說的是「等不到包」，聽起來像
 * 包壞了。先等服務可達（不計入預算），再開始等包。
 */
async function waitPackageStatus(id, wantLoaded, timeoutMs = 90000) {
  const api = frameworkApi();
  const bootDeadline = Date.now() + timeoutMs;
  while (Date.now() < bootDeadline) {
    if (await api.up()) break;
    await new Promise((k) => { setTimeout(k, 1000); });
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api.call('GET', `/api/packages/${id}`);
    // Installing a Package must preserve a user's explicit disabled setting.
    // The Installed Root is valid in both states; enablement is a separate
    // Package Setting action and must not turn a disabled install into a failed
    // install or delete the newly installed Release.
    if (wantLoaded && r?.ok && ['loaded', 'disabled'].includes(r.package?.status)) return { ok: true, status: r.package.status };
    if (!wantLoaded && (r === null || r?.error === 'unknown_package')) return { ok: true };
    if (wantLoaded && r?.ok && r.package?.status === 'failed') return { ok: false, error: r.package.error };
    await new Promise((k) => { setTimeout(k, 1000); });
  }
  return { ok: false, error: 'timeout waiting for package status' };
}

async function stopOwnedServices(manifest) {
  const api = frameworkApi();
  if (!await api.up()) return;
  for (const sid of manifest.components?.services ?? []) {
    await api.call('POST', `/api/stage/services/${sid}/stop?preserve_desired=1`); // Quiesce：不改用戶 desired
  }
}

const readActive = (id) => {
  try { return JSON.parse(fs.readFileSync(path.join(installedRoot(), id, ACTIVE_FILENAME), 'utf8')); }
  catch { return null; }
};

// 原子激活：tmp+rename；失敗恢復由調用方拿舊 active 內容兜底
function writeActive(id, active) {
  const dir = path.join(installedRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${ACTIVE_FILENAME}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(active, null, 2)}\n`);
  fs.renameSync(tmp, path.join(dir, ACTIVE_FILENAME));
}

// ============================================================
// Asset payload 安裝（024 §6.1）
// ============================================================
/**
 * 把 Model Asset Package 的 payload 落到 `/sdcard/termux-os/models` 下的**共享不可變版本目錄**（024 §5）。
 *
 * 為何非得去 models：com.termux_os.app 讀不到 Termux 私有目錄，且模型/cache 的公共根是穩定契約。
 * 為何不可變：同一版本的 payload 一旦落盤就不再改——rollback 只切登記指針，不搬 479MB。
 * 為何 sha 相同就複用：重裝/換 target 常常指向同一份位元組，再抄一次純屬浪費。
 * 為何 sha 不同要拒：那說明「同一個版本」有兩種內容，與 022 的 Release 不可變一脈相承；
 *   且靜默覆蓋別人 /sdcard 上的模型是 022 明令的紅線。
 */
/**
 * 遠程 payload：直接取到最終版本目錄。
 *
 * ⭐ 不經 `.staging` 再搬——那一步是為了「解包後再原子換入」，而這裡每個檔案本來就是
 * 先寫 `.part`、校驗通過才 rename，原子性已經在檔案這一層做到了。多搬一次 937 MB
 * 只是把同樣的字節在同一個檔案系統上再抄一遍。
 *
 * ⚠ 版本目錄不可變：同版本已有內容且 sha 相符就復用，不相符就拒絕覆蓋。
 */
/**
 * 載荷的落盤 target：資產自己宣告了就用它，否則跟包走。
 *
 * ⚠ 一個 generic 的包可以帶著 V73 與 V79 兩份 ctx——若都按包的 target 落盤，
 * 它們會進同一個目錄互相覆蓋，而 EPContext 的 wrapper 以 `./model.bin` 引用它的
 * context binary，換機那一份會被照常打開再在加載期報 `Error code: 5000`。
 */
const payloadTarget = (asset, packageTargetId) => asset.target?.id ?? packageTargetId;

async function installRemoteAssetPayload(asset, manifest, targetId, options) {
  const finalDir = path.join(
    assetVersionDir(manifest.id, manifest.version, payloadTarget(asset, targetId)),
    path.basename(asset.payload),
  );
  const files = asset.source.files;
  const need = pendingBytes(files, finalDir);
  const space = checkFreeSpace(path.dirname(finalDir), need);
  if (!space.ok) {
    die(`asset ${asset.id}: needs ${need} bytes, only ${space.free_bytes} available in ${sharedStore()}`);
  }
  if (need > 0) console.log(`asset ${asset.id}: fetching ${need} bytes → ${finalDir}`);
  const landed = await fetchAssetFiles(files, finalDir, {
    via: options.via, registryBase: options.registryBase,
    onProgress: ({ file, stage, bytes, total }) => {
      if (stage === 'done') console.log(`  ${file}: ${bytes} bytes verified`);
      if (stage === 'reused') console.log(`  ${file}: already present, reused`);
    },
  });
  const checksums = Object.fromEntries(files.map((f) => [f.path, f.sha256]));
  console.log(`asset ${asset.id}: payload installed → ${finalDir}`);
  return { asset, dir: finalDir, checksums, landed };
}

async function installAssetPayloads(stagedPkg, manifest, targetId, options = {}) {
  const provides = manifest.assets?.provides ?? [];
  if (!provides.length) return [];
  const store = sharedStore();
  const staging = path.join(store, '.staging', `${manifest.id}-${Date.now()}`);
  const installed = [];
  const profile = deviceProfile();
  try {
    for (const a of provides) {
      /**
       * ⛔ 可選資產安裝時不取。它仍然被登記為 provider（`package.mjs` 的 register 照跑），
       * 所以狀態頁看得見「有這個檔位、尚未取得」——那與「不存在」是兩件事。
       * 取它由明確的動作觸發（`POST /api/assets/<id>/fetch`），因為「要哪一檔」
       * 是安裝之後才做的選擇。
       */
      /**
       * ⛔ 別台機器的硬件版本不裝。一個包可以同時備好 V73 與 V79，但這台機器上
       * 只有一份能用；把另一份也拖下來既浪費幾百 MB，也讓「裝好了」變成一句
       * 不知道指哪一份的話。
       *
       * ⚠ 這一條排在 optional 之前。反過來的話，一個包宣告的兩份 ctx 會印出兩行
       * 一模一樣的 "optional, not fetched"——讀起來像同一件事做了兩遍，而真正該說的是
       * 其中一份根本不是給這台機器的。
       */
      if (a.target && !matchTarget(a.target, profile).ok) {
        console.log(`asset ${a.id}: variant ${a.target.id} is not for this device, skipped`);
        continue;
      }
      if (a.optional === true) {
        console.log(`asset ${a.id}: optional, not fetched at install`);
        continue;
      }
      // 遠程宣告的 payload 不在歸檔裡——它按坐標去取，不必也不該被打進包。
      if (a.source?.files?.length) {
        installed.push(await installRemoteAssetPayload(a, manifest, targetId, options));
        continue;
      }
      const srcDir = path.join(stagedPkg, a.payload);
      if (!fs.existsSync(srcDir)) throw new Error(`asset payload missing in archive: ${a.payload}`);

      // 先在 staging 復驗 asset.json 宣告的 checksum——落盤之前就要知道東西是好的
      const metaName = a.files?.metadata;
      let checksums = {};
      if (metaName) {
        const meta = JSON.parse(fs.readFileSync(path.join(srcDir, metaName), 'utf8'));
        for (const f of meta.files ?? []) {
          const p = path.join(srcDir, f.path);
          if (!fs.existsSync(p)) throw new Error(`asset ${a.id}: declared file missing: ${f.path}`);
          const got = sha256File(p);
          if (f.sha256 && got !== f.sha256) {
            throw new Error(`asset ${a.id}: ${f.path} checksum mismatch (asset.json says ${f.sha256}, got ${got})`);
          }
          checksums[f.path] = got;
        }
      }
      for (const [role, f] of Object.entries(a.files ?? {})) {
        if (!fs.existsSync(path.join(srcDir, f))) throw new Error(`asset ${a.id}: ${role} file missing: ${f}`);
      }

      const finalDir = path.join(assetVersionDir(manifest.id, manifest.version, payloadTarget(a, targetId)), path.basename(a.payload));
      if (fs.existsSync(finalDir)) {
        // 已存在：sha 全同=複用（冪等）；有一個不同=拒（不覆蓋，也不假裝成功）
        const diff = Object.entries(checksums).filter(([rel, want]) => {
          const p = path.join(finalDir, rel);
          return !fs.existsSync(p) || sha256File(p) !== want;
        });
        if (diff.length) {
          throw new Error(`asset ${a.id}: ${finalDir} already exists with different content `
            + `(${diff.map(([r]) => r).join(', ')}); refusing to overwrite /sdcard payload — bump the asset version`);
        }
        console.log(`asset ${a.id}: payload already present with identical sha256, reused`);
      } else {
        const stage = path.join(staging, path.basename(a.payload));
        fs.mkdirSync(stage, { recursive: true });
        for (const f of fs.readdirSync(srcDir)) fs.copyFileSync(path.join(srcDir, f), path.join(stage, f));
        for (const [rel, want] of Object.entries(checksums)) { // 落盤後再驗一次：/sdcard 是 FUSE，抄壞過
          if (sha256File(path.join(stage, rel)) !== want) throw new Error(`asset ${a.id}: ${rel} corrupted while copying to shared store`);
        }
        fs.mkdirSync(path.dirname(finalDir), { recursive: true });
        fs.renameSync(stage, finalDir); // 原子上位
        console.log(`asset ${a.id}: payload installed → ${finalDir}`);
      }
      installed.push({ asset: a, dir: finalDir, checksums });
    }
    return installed;
  } finally {
    fs.rmSync(path.join(store, '.staging'), { recursive: true, force: true });
  }
}

/** payload 就位後才登記為 active（登記指向的東西必須真的在） */
function registerInstalledAssets(installed, manifest, targetId, targetSpec) {
  for (const { asset, dir, checksums } of installed) {
    activateAsset(asset.id, {
      package_id: manifest.id,
      version: manifest.version,
      target: targetId,
      target_spec: targetSpec ?? null,
      path: dir,
      files: asset.files ?? {},
      checksums,
      sha256: Object.values(checksums)[0] ?? null,
    });
    console.log(`asset ${asset.id}: registered active ${manifest.version} [${targetId}]`);
  }
}

// ============================================================
// profile（023 §6）／check <tar>／check-installed <id>（§9）
// ============================================================
function cmdProfile() {
  console.log(JSON.stringify(deviceProfile(), null, 2));
}

/** 安裝前置檢查（§9）：target + bundled + external 一次算清，不改現場 */
async function cmdCheck(tarPath, args) {
  const v = await verifyArchive(tarPath, `${tarPath}.sha256`);
  if (!v.ok) die(`verify failed: ${v.error}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-check-'));
  let ok = false;
  try {
    execFileSync('tar', ['-xzf', tarPath, '-C', tmp]);
    const r = preflight(path.join(tmp, v.top_id), v.manifest, { force: args.includes('--force-target') });
    const portContract = checkPackagePorts(v.id, v.manifest.ports ?? []);
    console.log(JSON.stringify({
      ...r,
      port_contract: portContract,
      /**
       * ⭐ 只报**声明**，不报状态。
       *
       * 这个进程认识这个归档，但不认识这台设备正在跑什么：Capability 注册表活在
       * Framework 进程的内存里。所以这里交出「它要什么」，由 server 回答「拿到了没有」——
       * 两边各答自己真的知道的那一半，比任何一边猜另一半都准。
       */
      dependencies: { requires: declaredDependencies(v.manifest) },
      package: {
        id: v.id,
        name: v.manifest.name,
        version: v.version,
        target: v.target.id,
        types: v.manifest.types,
        ports: v.manifest.ports ?? [],
        services: (v.manifest.components?.services ?? [])
          .map((s) => typeof s === 'string' ? s : s.id).filter(Boolean),
        sha256: v.sha256,
      },
    }, null, 2));
    ok = r.ok && portContract.ok;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (!ok) process.exitCode = 1;
}

function cmdCheckInstalled(id, args) {
  const active = readActive(id);
  if (!active) die(`${id} is not installed`);
  const dir = path.join(installedRoot(), id, 'versions', active.active_version);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf8'));
  const r = preflight(dir, manifest, { force: args.includes('--force-target') });
  console.log(JSON.stringify({ id, version: active.active_version, active_target: active.active_target ?? TARGET_GENERIC, ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

// ============================================================
// install <tar> [sha256] [--force-target] [--allow-missing-external]
//（§6.2–6.4：staging→原子激活→失敗零半成品；023 §6.2/§9.1：裝之前先判機型與依賴）
// ============================================================
async function cmdInstall(tarPath, shaPath, args = []) {
  const v = await verifyArchive(tarPath, shaPath ?? `${tarPath}.sha256`);
  if (!v.ok) die(`verify failed: ${v.error}`);
  const portContract = checkPackagePorts(v.id, v.manifest.ports ?? []);
  if (!portContract.ok) die(`Package port contract failed: ${portContract.detail}`);
  const { id, version, sha256, manifest } = v;
  const root = installedRoot();
  const pkgDir = path.join(root, id);
  const prevActive = readActive(id);
  const forceTarget = args.includes('--force-target');
  const allowMissing = args.includes('--allow-missing-external');

  // 023 §6.2/§9.1：**在動現場之前**判機型與外部依賴——裝到一半才發現不兼容，
  // 代價是把一個好好的 active version 換成一個跑不起來的
  const profile = deviceProfile();
  const t = resolveTarget(manifest, profile);
  if (!t.ok && !(forceTarget && t.verdict === 'needs_force')) {
    const hint = t.verdict === 'needs_force'
      ? '\n  device reports unknown for some fields; re-run with --force-target to install anyway (risk: runtime crash)'
      : '';
    die(`target mismatch: archive targets "${t.target?.id}", this device is `
      + `${profile.os}/${profile.arch}/htp=${profile.htp}/qnn=${profile.qnn}\n  ${t.reasons.join('\n  ')}${hint}`);
  }
  if (forceTarget && t.verdict === 'needs_force') {
    console.log(`WARNING: --force-target — target "${t.target?.id}" could not be confirmed:\n  ${t.reasons.join('\n  ')}`);
  }
  /**
   * dev 保护：active 工作树被改过就不许静默覆盖。
   *
   * 判据来自工作树本身，所以「使用者改了什么」和「系统以为他改了什么」不可能分歧。
   * ⚠ unknown 不当作 dirty——旧的 source_tar 包没有 Git 身份，把它们一律拒绝会让
   * 过渡期所有升级停摆；但也绝不当作 clean 去覆盖，unknown 只是不触发这道门。
   */
  if (prevActive) {
    const prevDir = path.join(pkgDir, 'versions', prevActive.active_version);
    const git = packageGitState(prevDir);
    let prevHead = null;
    try { prevHead = JSON.parse(fs.readFileSync(archiveMetaPath(pkgDir, prevActive.active_version, prevActive.active_target ?? TARGET_GENERIC), 'utf8')).head ?? null; }
    catch { /* 舊安裝沒有這份記錄。 */ }
    const nowHead = packageGitIdentity(prevDir).head;
    if (prevHead && nowHead && prevHead !== nowHead) {
      git.state = GIT_STATE.DEV;
      git.changes = git.changes.length ? git.changes
        : [{ code: 'HD', path: `HEAD ${nowHead.slice(0, 12)} ≠ released ${prevHead.slice(0, 12)}`, untracked: false }];
    }
    if (git.state === GIT_STATE.DEV && !args.includes('--force-dirty')) {
      const sample = git.changes.slice(0, 10).map((c) => `    ${c.code} ${c.path}`).join('\n');
      die(`${id} ${prevActive.active_version} has local modifications (${git.changes.length} change(s)); refusing to overwrite them:\n`
        + `${sample}${git.changes.length > 10 ? '\n    …' : ''}\n`
        + '  Commit or push them, copy them out, or run\n'
        + `    node scripts/package-manager.mjs restore ${id}\n`
        + '  to return to the released content first. --force-dirty overrides and discards them.');
    }
    if (git.state === GIT_STATE.DEV) {
      console.log(`WARNING: --force-dirty — discarding ${git.changes.length} local change(s) in ${id} ${prevActive.active_version}`);
    }
  }
  const ext = checkExternal(manifest);
  const missing = ext.items.filter((i) => i.ok === false && i.required);
  if (missing.length && !allowMissing) {
    die(`missing required external dependencies (declared in manifest runtime):\n`
      + `${missing.map((i) => `  ${i.id}: ${i.reason}`).join('\n')}\n`
      + '  install refused; active version unchanged. Provide them, or --allow-missing-external for dev only.');
  }
  if (missing.length) console.log(`WARNING: --allow-missing-external — package will be degraded: ${missing.map((i) => i.id).join(', ')}`);

  // 同版本規則（§6.3）：任何已知版本槽（active 或 previous）都不許換內容
  // 023 §7.1：身份=id+version+**target**，故同版本不同 target 允許不同 hash
  const sameTarget = (prevActive?.active_target ?? TARGET_GENERIC) === (t.target?.id ?? TARGET_GENERIC);
  if (prevActive?.active_version === version && sameTarget) {
    if (prevActive.archive_sha256 === sha256) { console.log(`already installed ${id} ${version} (changed=false)`); return; }
    die(`same version ${version} + same target ${t.target?.id} with different hash refused (installed ${prevActive.archive_sha256}, archive ${sha256}); bump the version`);
  }
  const knownHash = prevActive?.hashes?.[`${version}@${t.target?.id ?? TARGET_GENERIC}`];
  if (knownHash && knownHash !== sha256) {
    die(`version ${version} target ${t.target?.id} was previously installed with different hash (${knownHash}); bump the version`);
  }

  const staging = path.join(root, '.staging', `${id}-${Date.now()}`);
  const cleanup = () => fs.rmSync(path.join(root, '.staging'), { recursive: true, force: true });
  let assetsInstalled = [];
  try {
    fs.mkdirSync(staging, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', staging]);
    const stagedRoot = path.join(staging, v.top_id);
    const stagedPkg = path.join(staging, id);
    if (v.top_id !== id) fs.renameSync(stagedRoot, stagedPkg);
    if (!fs.existsSync(path.join(stagedPkg, MANIFEST_FILENAME))) throw new Error('staging missing manifest');

    await stopOwnedServices(manifest);

    // 024：大 payload 先落共享 store（失敗就在這裡拋，active 尚未動）
    assetsInstalled = await installAssetPayloads(stagedPkg, manifest, t.target?.id ?? TARGET_GENERIC, {
      via: args.includes('--direct') ? 'direct' : 'registry',
      registryBase: process.env.PACKAGE_REGISTRY_URL || 'https://package.termux-os.com',
    });

    // 原包先落 archive/：字节已经过 sha256 与 verify，而 active 还没动，
    // 所以这一步失败不会留下半成品，也不会让恢复源与安装内容不一致。
    saveOriginalArchive(pkgDir, tarPath, {
      id, version, target: t.target?.id ?? TARGET_GENERIC, sha256,
      origin: readInstallOrigin(tarPath),
      // 發布態的 HEAD。⚠ 少了它，使用者只要把改動 commit 掉，工作樹就重新變乾淨，
      // 狀態讀回 release——而內容跟發布的已經不是同一份。「乾淨」不等於「沒改過」。
      head: packageGitIdentity(stagedPkg).head,
    });

    const versionDir = path.join(pkgDir, 'versions', version);
    fs.rmSync(versionDir, { recursive: true, force: true }); // 殘留半成品清掉（同版本不同 hash 已在上面擋）
    fs.mkdirSync(path.dirname(versionDir), { recursive: true });
    fs.renameSync(stagedPkg, versionDir);

    const targetId = t.target?.id ?? TARGET_GENERIC;
    writeActive(id, {
      schema: ACTIVE_SCHEMA, id,
      active_version: version,
      active_target: targetId,                                     // 023 §7.2
      previous_version: prevActive?.active_version ?? null,
      previous_target: prevActive?.active_target ?? (prevActive ? TARGET_GENERIC : null),
      archive_sha256: sha256,
      installed_at: new Date().toISOString(),
      // rollback 時還原對應 sha；鍵含 target（§7.1：同版本不同 target 是不同 Release）
      hashes: { ...(prevActive?.hashes ?? {}), [`${version}@${targetId}`]: sha256 },
    });

    // payload 已就位、active.json 已寫 → 才登記 asset 為 active（登記指向的東西必須真的在）
    registerInstalledAssets(assetsInstalled, manifest, targetId, t.target?.id === TARGET_GENERIC ? null : t.target);

    if (!frameworkRestart()) console.log('note: framework.sh not found, skipped restart (dev machine?)');
    else {
      const w = await waitPackageStatus(id, true);
      if (!w.ok) throw new Error(`post-install check failed: ${w.error}`);
    }

    // 只留 active+previous 兩個版本（§8）；必須在 post-install 成功後才修剪——
    // 否則 broken 更新會先剪掉可回退的舊版本目錄
    const keep = new Set([version, prevActive?.active_version].filter(Boolean));
    for (const d of fs.readdirSync(path.join(pkgDir, 'versions'))) {
      if (!keep.has(d)) fs.rmSync(path.join(pkgDir, 'versions', d), { recursive: true, force: true });
    }
    // archive/ 与 versions/ 保持同一个版本集合：留着一个无处可装的归档没有意义，
    // 而少留一个会让 rollback 之后的 restore 失去来源。
    pruneArchives(pkgDir, keep);
    cleanup();
    console.log(`installed ${id} ${version} (sha256 ${sha256.slice(0, 12)}…)`);
  } catch (e) {
    // 失敗恢復（§6.4）：staging 清除、active 復原、舊版本回歸、framework 重啟
    cleanup();
    if (prevActive) {
      writeActive(id, prevActive);
      // 只有真的重啟了 framework 才值得等它把包載回來。沒有 framework.sh（開發機/未 bootstrap）時
      // 硬等 = 白白 30 秒輪詢一個不存在的服務，然後報「RECOVERY PROBLEM」嚇人——恢復其實好好的
      const restarted = frameworkRestart();
      const w = restarted ? await waitPackageStatus(id, true) : { ok: true, skipped: true };
      const how = w.skipped ? 'framework not running, active.json restored'
        : (w.ok ? 'loaded' : `RECOVERY PROBLEM: ${w.error}`);
      console.error(`install failed, restored ${id} ${prevActive.active_version} (${how})`);
    } else {
      fs.rmSync(pkgDir, { recursive: true, force: true });
      frameworkRestart();
      console.error(`install failed, no previous version — ${id} removed`);
    }
    die(String(e?.message ?? e));
  }
}

// ============================================================
// 原包保存与恢复（archive/）
// ============================================================

/** 安装来源。远端下载时由调用方写在 tar 旁的 sidecar 里；本地装则只有路径。 */
function readInstallOrigin(tarPath) {
  try { return JSON.parse(fs.readFileSync(`${tarPath}.origin.json`, 'utf8')); }
  catch { return { kind: 'local_file', path: path.basename(tarPath) }; }
}

/**
 * 把已通过校验的原始归档留下来。
 *
 * ⭐ 恢复正式态的来源必须是**字节**，不能是 `git checkout -- .`：后者恢复不了被删掉的
 * 未跟踪文件，也修不好 `.git` 自身被改动的情况，而它对「包里本来有什么」的认知来自
 * 那个可能已经被改坏的工作树。
 */
function saveOriginalArchive(pkgDir, tarPath, meta) {
  const dir = archiveDir(pkgDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = archiveTarPath(pkgDir, meta.version, meta.target);
  const tmp = `${dest}.part`;
  fs.copyFileSync(tarPath, tmp);
  const digest = sha256File(tmp);
  if (digest !== meta.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`archive copy mismatch: expected ${meta.sha256}, got ${digest}`);
  }
  fs.renameSync(tmp, dest);
  fs.writeFileSync(archiveMetaPath(pkgDir, meta.version, meta.target), `${JSON.stringify({
    schema: 'termux-os.package-archive.v1',
    id: meta.id,
    version: meta.version,
    target: meta.target,
    sha256: meta.sha256,
    size: fs.statSync(dest).size,
    origin: meta.origin ?? null,
    head: meta.head ?? null,
    saved_at: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`archived original ${archiveKey(meta.version, meta.target)} (${fs.statSync(dest).size} bytes)`);
}

/** archive/ 只保留仍然装得回去的版本，与 versions/ 同一个集合。 */
function pruneArchives(pkgDir, keepVersions) {
  const dir = archiveDir(pkgDir);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const version = name.split('@')[0];
    if (!keepVersions.has(version)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

// ============================================================
// restore <id>（把 active 版本的内容换回保存的原包）
// ============================================================
async function cmdRestore(id) {
  const root = installedRoot();
  const active = readActive(id);
  if (!active) die(`${id} is not installed`);
  const pkgDir = path.join(root, id);
  const version = active.active_version;
  const target = active.active_target ?? TARGET_GENERIC;
  const tar = archiveTarPath(pkgDir, version, target);
  if (!fs.existsSync(tar)) {
    die(`no saved archive for ${id} ${archiveKey(version, target)}.\n`
      + '  Only versions installed by a build that saves originals can be restored offline;\n'
      + '  reinstall this version from the catalog to obtain one.');
  }
  const expected = active.hashes?.[archiveKey(version, target)] ?? active.archive_sha256 ?? null;
  const actual = sha256File(tar);
  if (expected && actual !== expected) {
    die(`saved archive is not the installed release: expected ${expected}, got ${actual}; refusing to restore`);
  }
  const v = await verifyArchive(tar, null, { expectedSha256: actual });
  if (!v.ok) die(`saved archive failed verification: ${v.error}`);
  if (v.id !== id || v.version !== version) {
    die(`saved archive identity mismatch: archive is ${v.id} ${v.version}, active is ${id} ${version}`);
  }

  const versionDir = path.join(pkgDir, 'versions', version);
  const staging = path.join(root, '.staging', `${id}-restore-${Date.now()}`);
  // 修改前的现场先挪开而不是删掉——恢复失败时它是唯一能还回去的东西。
  const held = `${versionDir}.restoring-${Date.now()}`;
  let movedAside = false;
  try {
    fs.mkdirSync(staging, { recursive: true });
    execFileSync('tar', ['-xzf', tar, '-C', staging]);
    const stagedRoot = path.join(staging, v.top_id);
    const stagedPkg = path.join(staging, id);
    if (v.top_id !== id) fs.renameSync(stagedRoot, stagedPkg);
    if (!fs.existsSync(path.join(stagedPkg, MANIFEST_FILENAME))) throw new Error('staging missing manifest');

    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(versionDir, MANIFEST_FILENAME), 'utf8')); } catch { /* 当前版本坏了正是 restore 的理由 */ }
    if (manifest) await stopOwnedServices(manifest);

    if (fs.existsSync(versionDir)) { fs.renameSync(versionDir, held); movedAside = true; }
    fs.renameSync(stagedPkg, versionDir);
    fs.rmSync(path.join(root, '.staging'), { recursive: true, force: true });
    if (movedAside) fs.rmSync(held, { recursive: true, force: true });

    // config/、persist/data、外置 asset 一律没碰过：它们本来就不在 versionDir 之下。
    if (!frameworkRestart()) console.log('note: framework.sh not found, skipped restart (dev machine?)');
    else {
      const w = await waitPackageStatus(id, true);
      if (!w.ok) throw new Error(`post-restore check failed: ${w.error}`);
    }
    const git = packageGitState(versionDir);
    console.log(`restored ${id} ${version} [${target}] from saved archive (${describeGitState(git)})`);
    if (git.state === GIT_STATE.DEV) {
      console.error(`WARNING: work tree is still not clean after restore: ${git.changes.length} change(s)`);
      process.exitCode = 1;
    }
  } catch (e) {
    fs.rmSync(path.join(root, '.staging'), { recursive: true, force: true });
    if (movedAside && fs.existsSync(held)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
      fs.renameSync(held, versionDir);
      frameworkRestart();
      console.error(`restore failed, put the previous content back at ${versionDir}`);
    }
    die(String(e?.message ?? e));
  }
}

// ============================================================
// state <id>（release / dev / unknown，读自工作树）
// ============================================================
function cmdState(id) {
  const active = readActive(id);
  if (!active) die(`${id} is not installed`);
  const dir = path.join(installedRoot(), id, 'versions', active.active_version);
  const git = packageGitState(dir);
  const identity = packageGitIdentity(dir);
  const pkgRoot = path.join(installedRoot(), id);
  const target = active.active_target ?? TARGET_GENERIC;
  let releasedHead = null;
  try { releasedHead = JSON.parse(fs.readFileSync(archiveMetaPath(pkgRoot, active.active_version, target), 'utf8')).head ?? null; }
  catch { /* 舊安裝沒有這份記錄。 */ }
  /**
   * 提交過的本地改動同樣是 dev。
   *
   * `git status` 只看得見「還沒 commit 的差異」。使用者一 commit，工作樹就乾淨了，
   * 而內容跟發布的那一份已經分了岔。乾淨 ≠ 沒改過，所以判據要多問一句 HEAD。
   */
  const diverged = Boolean(releasedHead && identity.head && identity.head !== releasedHead);
  const state = git.state === GIT_STATE.RELEASE && diverged ? GIT_STATE.DEV : git.state;
  console.log(JSON.stringify({
    id,
    version: active.active_version,
    target,
    state,
    reason: state === GIT_STATE.DEV && diverged && git.state === GIT_STATE.RELEASE
      ? 'head_diverged_from_release' : git.reason,
    released_head: releasedHead,
    head_diverged: diverged,
    error: git.error,
    changes: git.changes,
    ignored_paths: git.ignored,
    git: identity,
    restorable: fs.existsSync(archiveTarPath(pkgRoot, active.active_version, target)),
  }, null, 2));
}

// ============================================================
// uninstall <id>（§7：只刪代碼；配置/數據/綁定/Desired 全保留）
// ============================================================
async function cmdUninstall(id) {
  const root = installedRoot();
  const active = readActive(id);
  if (!active) { console.log(`${id} is not installed (changed=false)`); return; }
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, id, 'versions', active.active_version, MANIFEST_FILENAME), 'utf8')); }
  catch { /* 版本目錄壞了也照樣卸載 */ }
  if (manifest) await stopOwnedServices(manifest);
  // 024 §6.3：只摘 active 登記，**payload 一律保留**（無 purge）——大模型重裝一次要幾分鐘，
  // 而且 /sdcard 上的東西不歸安裝器處置。使用方會如實看到 missing_asset，不會退回某個不明模型
  for (const a of manifest?.assets?.provides ?? []) {
    if (deactivateAsset(a.id)) console.log(`asset ${a.id}: deactivated (shared payload kept on disk)`);
  }
  fs.rmSync(path.join(root, id), { recursive: true, force: true }); // active.json + 全部版本
  if (frameworkRestart()) {
    const w = await waitPackageStatus(id, false);
    if (!w.ok) die(`uninstall post-check failed: ${w.error}`);
  }
  console.log(`uninstalled ${id} (was ${active.active_version}); config/data/bindings/desired preserved`);
}

// ============================================================
// rollback <id>（§8：active ↔ previous 互換；只留兩版本）
// ============================================================
async function cmdRollback(id) {
  const root = installedRoot();
  const active = readActive(id);
  if (!active) die(`${id} is not installed`);
  const prev = active.previous_version;
  if (!prev) die(`${id} has no previous version to roll back to`);
  const prevDir = path.join(root, id, 'versions', prev);
  if (!fs.existsSync(prevDir)) die(`previous version directory missing: versions/${prev}`);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, id, 'versions', active.active_version, MANIFEST_FILENAME), 'utf8')); }
  catch { /* 當前版本壞了正是 rollback 的理由 */ }
  if (manifest) await stopOwnedServices(manifest);
  // 023：target 隨版本一起互換；hashes 鍵含 target（舊 active.json 無 target = generic）
  const prevTarget = active.previous_target ?? TARGET_GENERIC;
  writeActive(id, {
    ...active,
    active_version: prev,
    active_target: prevTarget,
    previous_version: active.active_version, // 互換：允許 rollback 的 rollback
    previous_target: active.active_target ?? TARGET_GENERIC,
    archive_sha256: active.hashes?.[`${prev}@${prevTarget}`] ?? active.hashes?.[prev] ?? null,
    installed_at: new Date().toISOString(),
  });
  // 024 §6.2：Asset 的 rollback = **只切登記指針**，不複製、不重解壓大檔（payload 各版本都還在）
  let prevManifest = null;
  try { prevManifest = JSON.parse(fs.readFileSync(path.join(prevDir, MANIFEST_FILENAME), 'utf8')); } catch { /* 舊版壞了 */ }
  for (const a of prevManifest?.assets?.provides ?? []) {
    const dir = path.join(assetVersionDir(id, prev, prevTarget), path.basename(a.payload));
    if (!fs.existsSync(dir)) { console.error(`WARNING: asset ${a.id}: payload for ${prev} not found at ${dir}`); continue; }
    const checksums = {};
    const metaName = a.files?.metadata;
    if (metaName && fs.existsSync(path.join(dir, metaName))) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, metaName), 'utf8'));
      for (const f of meta.files ?? []) checksums[f.path] = f.sha256;
    }
    activateAsset(a.id, {
      package_id: id, version: prev, target: prevTarget,
      target_spec: prevManifest?.targets?.find((t) => t.id === prevTarget) ?? null,
      path: dir, files: a.files ?? {}, checksums, sha256: Object.values(checksums)[0] ?? null,
    });
    console.log(`asset ${a.id}: registry now points at ${prev} (no bytes copied)`);
  }

  if (frameworkRestart()) {
    const w = await waitPackageStatus(id, true);
    if (!w.ok) die(`rollback post-check failed: ${w.error}`);
  }
  console.log(`rolled back ${id} to ${prev} (previous now ${active.active_version})`);
}

function cmdList() {
  const root = installedRoot();
  let ids = [];
  try { ids = fs.readdirSync(root).filter((d) => !d.startsWith('.')); } catch { /* 空 */ }
  if (!ids.length) { console.log(`(no packages installed under ${root})`); return; }
  for (const id of ids.sort()) {
    const a = readActive(id);
    if (!a) { console.log(`${id}  (broken: no active.json)`); continue; }
    // 舊 active.json 沒有 target 欄位 = generic（§7.2 遷移規則，不改寫文件）
    const tgt = a.active_target ?? TARGET_GENERIC;
    console.log(`${id}  ${a.active_version} [${tgt}]${a.previous_version ? `  (prev ${a.previous_version})` : ''}  sha ${String(a.archive_sha256).slice(0, 12)}  ${a.installed_at}`);
  }
}

// ============================================================
// CLI
// ============================================================
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'pack': await cmdPack(rest[0] ?? die('usage: pack <package-id> [--target <id>] [--artifact-dir <path>] [--source <dir>]'), rest.slice(1)); break;
  case 'verify': await cmdVerify(rest[0] ?? die('usage: verify <tar> [sha256]'), rest[1]?.startsWith('--') ? undefined : rest[1]); break;
  case 'install': await cmdInstall(rest[0] ?? die('usage: install <tar> [sha256] [--force-target] [--allow-missing-external]'),
    rest[1]?.startsWith('--') ? undefined : rest[1], rest.slice(1)); break;
  case 'uninstall': await cmdUninstall(rest[0] ?? die('usage: uninstall <package-id>')); break;
  case 'rollback': await cmdRollback(rest[0] ?? die('usage: rollback <package-id>')); break;
  case 'list': cmdList(); break;
  case 'profile': cmdProfile(); break;
  case 'check': await cmdCheck(rest[0] ?? die('usage: check <tar> [--force-target]'), rest.slice(1)); break;
  case 'check-installed': cmdCheckInstalled(rest[0] ?? die('usage: check-installed <package-id>'), rest.slice(1)); break;
  case 'restore': await cmdRestore(rest[0] ?? die('usage: restore <package-id>')); break;
  case 'state': cmdState(rest[0] ?? die('usage: state <package-id>')); break;
  default:
    console.log('usage: node scripts/package-manager.mjs <pack|verify|install|uninstall|rollback|list|profile|check|check-installed> ...');
    process.exit(cmd ? 1 : 0);
}
