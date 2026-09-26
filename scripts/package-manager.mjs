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
import { MANIFEST_FILENAME, validateManifest, manifestTargets, matchTarget, TARGET_GENERIC, DEVICE_TARGET } from '../src/packages/manifest.mjs';
import { declaredDependencies } from '../src/packages/dependencies.mjs';
import { checkFreeSpace } from '../src/assets/fetch.mjs';
import { stagePullFiles } from '../src/assets/transfer/staging.mjs';
import { validateTransferUrl } from '../src/assets/transfer/http.mjs';
import {
  checkBundled, checkExternal, deviceProfile, resolveTarget, archiveName, scanForbiddenPaths, preflight,
  RELEASE_EXCLUDED_NAMES, RELEASE_EXCLUDED_SUFFIXES,
} from '../src/packages/runtime-contract.mjs';
// sha256File 用串流版（024）：舊的 readFileSync 版會把 450MB 的 tar 整個吃進記憶體——手機上會 OOM
import {
  sharedStore, assetVersionDir, sha256File, activateAsset, deactivateAsset, readRegistry,
  payloadLedgerPath, syncCompatibilityRegistry,
  readPayloadLedger, recordPayload, clearPayloadSelection, restorePayloadSelections, selectionKey,
} from '../src/assets/registry.mjs';
import { declarationVariantId } from '../src/assets/declarations.mjs';
import { commitStagedPayloads } from '../src/assets/transfer/commit.mjs';
import { defaultAuthFile, readAuthFile } from '../src/system/auth-file.mjs';
import { checkPackagePorts, configurePortRegistry } from '../src/system/port-registry.mjs';
import { packageGitIdentity, gitHistoryScan } from '../src/packages/git-state.mjs';
import {
  activateDevelopment, readDevelopment, writeDevelopment, clearDevelopment, releaseMetadata,
  listDevelopmentBackups, developmentBackupRoot as backupRoot, DEVELOPMENT_BACKUP_SCHEMA as BACKUP_SCHEMA,
} from '../src/packages/provenance.mjs';
import { isDevelopmentOnly } from '../src/packages/zero-create.mjs';
import { reconcilePackage, legacyWorkspaceCandidates } from '../src/packages/reconcile.mjs';
import { acquirePackageLockSync } from '../src/packages/operation-lock.mjs';

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

function lockPackage(id) {
  try { return acquirePackageLockSync(id, { root: installedRoot() }); }
  catch (error) { die(`${error.code ?? 'package_operation_locked'}: ${error.message}`); }
}

function requireReconciled(id, { allowLegacy = false } = {}) {
  const snapshot = reconcilePackage(id, { frameworkRoot: ROOT });
  const conflicts = allowLegacy
    ? snapshot.conflicts.filter((item) => item.kind !== 'legacy_workspace')
    : snapshot.conflicts;
  if (conflicts.length) {
    die(`${id} requires reconcile before this operation (${conflicts.map((item) => item.kind).join(', ')}).\n`
      + '  Run: node scripts/package-manager.mjs reconcile ' + id);
  }
  return snapshot;
}

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
  const call = async (method, p, { body = undefined, headers = {}, timeoutMs = 60000 } = {}) => {
    try {
      const r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
      return await r.json();
    } catch { return null; } // framework 不在 = null
  };
  return { call, up: async () => { try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } } };
}

/**
 * Resolve source coordinates through the currently bound replaceable Manager.
 * The installer owns the package transaction; the Manager only supplies
 * explicit transfer specs, so adding ModelScope or a signed source never
 * creates a Core/installer source branch.
 */
async function resolveAssetTransferFiles(asset) {
  const files = asset?.source?.files ?? [];
  const result = await frameworkApi().call('POST', '/api/capabilities/termux-os.assets.manager/invoke', {
    body: { input: { op: 'resolve_transfer', asset_id: asset.id, files } }, timeoutMs: 120_000,
  });
  if (!result?.ok || !result.value?.ok || !Array.isArray(result.value.files)) {
    const detail = result?.value?.detail || result?.value?.error || result?.reason || result?.error
      || 'Manager capability is unavailable';
    throw Object.assign(new Error(`asset ${asset.id}: source resolver unavailable — ${detail}`), {
      code: 'asset_source_resolver_unavailable',
    });
  }
  return result.value;
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

async function installRemoteAssetPayload(asset, manifest, targetId, options, stagingRoot) {
  const explicit = (() => {
    const declared = asset?.source?.files;
    if (!Array.isArray(declared) || !declared.length) return null;
    try { return declared.map((file) => ({ ...file, url: validateTransferUrl(file.url) })); }
    catch { return null; }
  })();
  // A manifest may carry a complete source-neutral URL, in which case the
  // Package installer can use Core directly. Coordinate-only manifests ask
  // the currently bound Manager to resolve them; this keeps ModelScope and
  // future signed/SDK sources out of Core and the installer.
  const resolved = explicit ? { files: explicit } : await resolveAssetTransferFiles(asset);
  const files = resolved.files;
  const finalDir = path.join(
    assetVersionDir(manifest.id, manifest.version, payloadTarget(asset, targetId)),
    path.basename(asset.payload),
  );
  const need = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const space = checkFreeSpace(path.dirname(finalDir), need);
  if (!space.ok) {
    die(`asset ${asset.id}: needs ${need} bytes, only ${space.free_bytes} available in ${sharedStore()}`);
  }
  if (need > 0) console.log(`asset ${asset.id}: fetching ${need} bytes → ${finalDir}`);
  const stage = path.join(stagingRoot, `payload-${path.basename(asset.payload)}-${Date.now()}`);
  const staged = await stagePullFiles(files, stage, {
    onProgress: ({ file, stage, bytes, total }) => {
      if (stage === 'done') console.log(`  ${file}: ${bytes} bytes verified`);
      if (stage === 'reused') console.log(`  ${file}: already present, reused`);
    },
  });
  const checksums = Object.fromEntries(files.map((f) => [f.path, f.sha256]));
  return { asset, dir: finalDir, checksums, files, stageRoot: stage,
    v2Metadata: { package_id: manifest.id, version: manifest.version,
      target: asset.target ?? targetId, provenance: 'package_install' }, landed: staged.landed };
}

async function installAssetPayloads(stagedPkg, manifest, targetId, options = {}) {
  const provides = manifest.assets?.provides ?? [];
  if (!provides.length) return [];
  const store = sharedStore();
  const staging = path.join(store, '.staging', `${manifest.id}-${Date.now()}`);
  const installed = [];
  const profile = deviceProfile();
  let handedOff = false;
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
      /**
       * ⭐ `device` 變體不在這裡取：它有哪些檔、從哪取，由目錄說了算，而那是 Manager 的事。
       * 包只是宣告「我提供這個 id」，裝上它不代表要替使用者下載幾百 MB。
       */
      if (a.target === DEVICE_TARGET) {
        console.log(`asset ${a.id}: per-device variant, provisioned by the asset Manager from its catalog`);
        continue;
      }
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
        installed.push(await installRemoteAssetPayload(a, manifest, targetId, options, staging));
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
      const stage = path.join(staging, `payload-${installed.length}-${path.basename(a.payload)}`);
      fs.mkdirSync(stage, { recursive: true });
      // The installer still exposes the legacy versioned path during the
      // migration release, but its bytes now use the same Core primitive as a
      // Manager transfer: isolated stage, full manifest verification, atomic
      // rename, and one Payload Ledger/Selection mutation.
      fs.cpSync(srcDir, stage, { recursive: true, force: false, errorOnExist: false });
      for (const [rel, want] of Object.entries(checksums)) { // /sdcard/FUSE 可能在抄寫時改變字節
        if (sha256File(path.join(stage, rel)) !== want) throw new Error(`asset ${a.id}: ${rel} corrupted while copying to shared store`);
      }
      const files = v2FilesFor(a, stage, checksums);
      installed.push({ asset: a, dir: finalDir, checksums, stageRoot: stage, files,
        v2Metadata: { package_id: manifest.id, version: manifest.version,
          target: a.target ?? targetId, provenance: 'package_install' } });
    }
    handedOff = true;
    return installed;
  } finally {
    // The active Installed Root is written after this function returns. Keep
    // bundled stages alive until registerInstalledAssets can commit them
    // against the now-visible Declaration Index. Any thrown install cleans up
    // immediately; the caller removes handed-off stages after registration.
    if (!handedOff) fs.rmSync(staging, { recursive: true, force: true });
  }
}

const v2FilesFor = (asset, dir, checksums = {}) => {
  const names = [...new Set(Object.values(asset.files ?? {}).filter((value) => typeof value === 'string' && value))];
  return names.map((relative) => {
    const filePath = path.join(dir, relative);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`asset ${asset.id}: file missing for v2 ledger: ${relative}`);
    return { path: relative, size: fs.statSync(filePath).size, sha256: checksums[relative] ?? sha256File(filePath) };
  });
};

/**
 * Bridge the already-installed bytes into the v2 Ledger. The first bridge
 * keeps the existing versioned directory in place (`layout=legacy`) so a
 * package update never copies a 900 MB model merely to change bookkeeping.
 */
function recordV2Asset(asset, dir, checksums, manifest, targetId, targetSpec = null) {
  const files = v2FilesFor(asset, dir, checksums);
  return recordPayload({
    files,
    storagePath: dir,
    layout: 'legacy',
    // The Package target and the Asset variant are different namespaces. A
    // generic Asset inside a targeted Package remains the generic Declaration;
    // selecting the Package target here makes the v2 bridge fail with a false
    // "no active Declaration" and rolls back an otherwise valid install.
    selection: { asset_id: asset.id, variant_id: declarationVariantId(asset) },
    package_id: manifest.id,
    version: manifest.version,
    target: targetSpec ?? asset.target ?? null,
    provenance: 'package_install',
  });
}

/** payload 就位後才登記為 active（登記指向的東西必須真的在） */
function registerInstalledAssets(installed, manifest, targetId, targetSpec) {
  const pending = installed.filter((item) => item.stageRoot && item.files);
  if (pending.length) {
    const committed = commitStagedPayloads({ payloads: pending.map((item) => ({
      files: item.files, stageRoot: item.stageRoot, storagePath: item.dir, layout: 'legacy',
      selection: { asset_id: item.asset.id, variant_id: declarationVariantId(item.asset) },
      metadata: item.v2Metadata,
    })) });
    for (const [index, item] of pending.entries()) item.v2 = committed.payloads[index];
  }
  for (const { asset, dir, checksums, v2 } of installed) {
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
    // Bundled payloads already entered the v2 Ledger in the same commit as
    // their bytes. Remote/legacy bridge results still pass through this
    // compatibility path until their Manager source resolver is wired in.
    if (!v2) recordV2Asset(asset, dir, checksums, manifest, targetId, asset.target ?? targetSpec);
    console.log(`asset ${asset.id}: registered active ${manifest.version} [${targetId}]`);
  }
  // The v1 entry above is only a bridge for old readers. Once a v2 Ledger is
  // present, restore its projection last so activateAsset() cannot leave a
  // stale v1 shape that disagrees with the authoritative Selection.
  const ledger = readPayloadLedger();
  if (!ledger.error && fs.existsSync(payloadLedgerPath())) syncCompatibilityRegistry(ledger);
}

const selectionEntriesFor = (...manifests) => {
  const entries = new Map();
  for (const manifest of manifests) {
    for (const asset of manifest?.assets?.provides ?? []) {
      if (!asset?.id) continue;
      const variantId = declarationVariantId(asset);
      entries.set(selectionKey(asset.id, variantId), { asset_id: asset.id, variant_id: variantId });
    }
  }
  return [...entries.values()];
};

const captureSelectionSnapshot = (ledger, entries) => entries.map((entry) => ({
  ...entry, selection: ledger.selections?.[selectionKey(entry.asset_id, entry.variant_id)] ?? null,
}));

/** Restore only this Package's Selection slice after active-root rollback. */
const restoreSelectionsAfterInstallFailure = (snapshot) => {
  if (!snapshot.length) return { changed: false };
  const ledger = readPayloadLedger();
  if (ledger.error) throw new Error(`cannot restore Asset Selections: ${ledger.error}`);
  return restorePayloadSelections(snapshot, { expectedGeneration: ledger.generation });
};

const cleanupAssetStages = (installed) => {
  for (const item of installed ?? []) if (item.stageRoot) {
    try {
      const parent = path.dirname(item.stageRoot);
      fs.rmSync(item.stageRoot, { recursive: true, force: true });
      try { fs.rmdirSync(parent); } catch { /* another operation may still use the shared staging parent */ }
    } catch { /* cleanup is best effort */ }
  }
};
const cleanupAssetStagingParent = () => {
  try { fs.rmdirSync(path.join(sharedStore(), '.staging')); } catch { /* another operation may still use it */ }
};

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
//        [--preserve-dirty | --force-dirty]
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
  const operationLock = lockPackage(id);
  requireReconciled(id);
  const prevActive = readActive(id);
  const previousManifest = (() => {
    if (!prevActive) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(root, id, 'versions', prevActive.active_version, MANIFEST_FILENAME), 'utf8'));
    } catch { return null; }
  })();
  const selectionEntries = selectionEntriesFor(previousManifest, manifest);
  const selectionSnapshot = captureSelectionSnapshot(readPayloadLedger(), selectionEntries);
  const forceTarget = args.includes('--force-target');
  const allowMissing = args.includes('--allow-missing-external');
  const protection = protectionMode(args);

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
   * Local history protection. The shared package state decides — Development provenance, a
   * modified work tree, HEAD off the release, a side branch or tag with unreleased commits, or
   * a stash all mean the active version holds something that exists nowhere else.
   * ⚠ A Package without verifiable lineage (no .git / no released HEAD) and no edits is `unknown`
   * and does not trigger this gate: refusing every legacy update would stall them all.
   */
  let historyGuard = { backup: false };
  let prevState = null;
  if (prevActive) {
    prevState = requireReconciled(id).package_state;
    historyGuard = guardLocalHistory(prevState, `updating ${id} ${prevActive.active_version}`, protection);
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
  // The one exception: a development-only Package has never had an official Release in any slot,
  // so its first verified Release may carry the same version ("officialization"). The local
  // history guard above has already required a backup or an explicit discard.
  const officializing = prevActive?.active_version === version && sameTarget && isDevelopmentOnly(prevActive);
  if (prevActive?.active_version === version && sameTarget && !officializing) {
    if (prevActive.archive_sha256 === sha256) {
      operationLock.release();
      console.log(`already installed ${id} ${version} (changed=false)`);
      return;
    }
    die(`same version ${version} + same target ${t.target?.id} with different hash refused (installed ${prevActive.archive_sha256}, archive ${sha256}); bump the version`);
  }
  if (officializing) console.log(`officializing development-only ${id} ${version} with verified Release ${sha256.slice(0, 12)}…`);
  const knownHash = prevActive?.hashes?.[`${version}@${t.target?.id ?? TARGET_GENERIC}`];
  if (knownHash && knownHash !== sha256) {
    die(`version ${version} target ${t.target?.id} was previously installed with different hash (${knownHash}); bump the version`);
  }

  const staging = path.join(root, '.staging', `${id}-${Date.now()}`);
  const cleanup = () => fs.rmSync(path.join(root, '.staging'), { recursive: true, force: true });
  let assetsInstalled = [];
  let officializeHeld = null;
  try {
    fs.mkdirSync(staging, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', staging]);
    const stagedRoot = path.join(staging, v.top_id);
    const stagedPkg = path.join(staging, id);
    if (v.top_id !== id) fs.renameSync(stagedRoot, stagedPkg);
    if (!fs.existsSync(path.join(stagedPkg, MANIFEST_FILENAME))) throw new Error('staging missing manifest');

    // Save before stopping services or moving the active version. The backup is the complete
    // version directory: deletions, untracked files, branches, commits and the stash.
    if (historyGuard.backup) backupActiveVersion(id, pkgDir, prevActive, prevState, 'update');

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
    if (officializing) {
      // The development tree occupies the same slot; hold it until the Release has passed post-check.
      officializeHeld = `${versionDir}.officialize-held-${Date.now()}`;
      fs.renameSync(versionDir, officializeHeld);
    }
    fs.rmSync(versionDir, { recursive: true, force: true }); // 殘留半成品清掉（同版本不同 hash 已在上面擋）
    fs.mkdirSync(path.dirname(versionDir), { recursive: true });
    fs.renameSync(stagedPkg, versionDir);

    const targetId = t.target?.id ?? TARGET_GENERIC;
    writeActive(id, {
      schema: ACTIVE_SCHEMA, id,
      active_version: version,
      active_target: targetId,                                     // 023 §7.2
      previous_version: officializing ? null : prevActive?.active_version ?? null,
      previous_target: officializing ? null : prevActive?.active_target ?? (prevActive ? TARGET_GENERIC : null),
      archive_sha256: sha256,
      installed_at: new Date().toISOString(),
      // rollback 時還原對應 sha；鍵含 target（§7.1：同版本不同 target 是不同 Release）
      hashes: { ...(prevActive?.hashes ?? {}), [`${version}@${targetId}`]: sha256 },
    });

    // payload 已就位、active.json 已寫 → 才登記 asset 為 active（登記指向的東西必須真的在）
    registerInstalledAssets(assetsInstalled, manifest, targetId, t.target?.id === TARGET_GENERIC ? null : t.target);
    cleanupAssetStages(assetsInstalled);
    cleanupAssetStagingParent();

    if (!frameworkRestart()) console.log('note: framework.sh not found, skipped restart (dev machine?)');
    else {
      const w = await waitPackageStatus(id, true);
      if (!w.ok) throw new Error(`post-install check failed: ${w.error}`);
    }

    if (officializeHeld) { fs.rmSync(officializeHeld, { recursive: true, force: true }); officializeHeld = null; }

    // 只留 active+previous 兩個版本（§8）；必須在 post-install 成功後才修剪——
    // 否則 broken 更新會先剪掉可回退的舊版本目錄。
    // A version directory with local history is archived first; if that fails it is kept.
    const keep = new Set([version, prevActive?.active_version].filter(Boolean));
    for (const d of fs.readdirSync(path.join(pkgDir, 'versions'))) {
      if (keep.has(d)) continue;
      const history = inactiveVersionHistory(pkgDir, d);
      if (history.local_history) {
        try {
          const backup = createDevelopmentBackup(path.join(pkgDir, 'versions', d), {
            id, version: d, target: history.target, reason: 'prune', released_head: history.released_head,
            state: { git: history, provenance: null, development: null },
          });
          console.log(`archived local history of ${id} ${d} before pruning (${backup.sha256.slice(0, 12)}…, ${backup.path})`);
        } catch (error) {
          keep.add(d);
          console.error(`WARNING: kept versions/${d}: it holds local history and could not be archived (${error.message})`);
          continue;
        }
      }
      fs.rmSync(path.join(pkgDir, 'versions', d), { recursive: true, force: true });
    }
    // archive/ 与 versions/ 保持同一个版本集合：留着一个无处可装的归档没有意义，
    // 而少留一个会让 rollback 之后的 restore 失去来源。
    pruneArchives(pkgDir, keep);
    // A verified official Release is active, serving, and pruning is done: only now is the
    // Package official again. Any earlier failure rolls back with the provenance untouched.
    if (readDevelopment(pkgDir)) {
      clearDevelopment(pkgDir);
      console.log(`${id}: development provenance cleared by the verified install of ${version}`);
    }
    cleanup();
    operationLock.release();
    console.log(`installed ${id} ${version} (sha256 ${sha256.slice(0, 12)}…)`);
  } catch (e) {
    // 失敗恢復（§6.4）：staging 清除、active 復原、舊版本回歸、framework 重啟
    cleanupAssetStages(assetsInstalled);
    cleanupAssetStagingParent();
    cleanup();
    if (officializeHeld && fs.existsSync(officializeHeld)) {
      const slot = path.join(pkgDir, 'versions', version);
      fs.rmSync(slot, { recursive: true, force: true });
      fs.renameSync(officializeHeld, slot);
      console.error(`restored the development tree of ${id} ${version} after the failed officialization`);
    }
    if (prevActive) {
      writeActive(id, prevActive);
      try {
        const restored = restoreSelectionsAfterInstallFailure(selectionSnapshot);
        if (restored.changed) console.error(`restored Asset Selections for ${id} after install failure`);
      } catch (restoreError) {
        console.error(`RECOVERY PROBLEM: Asset Selection restore failed for ${id}: ${restoreError.message}`);
      }
      // 只有真的重啟了 framework 才值得等它把包載回來。沒有 framework.sh（開發機/未 bootstrap）時
      // 硬等 = 白白 30 秒輪詢一個不存在的服務，然後報「RECOVERY PROBLEM」嚇人——恢復其實好好的
      const restarted = frameworkRestart();
      const w = restarted ? await waitPackageStatus(id, true) : { ok: true, skipped: true };
      const how = w.skipped ? 'framework not running, active.json restored'
        : (w.ok ? 'loaded' : `RECOVERY PROBLEM: ${w.error}`);
      console.error(`install failed, restored ${id} ${prevActive.active_version} (${how})`);
    } else {
      fs.rmSync(pkgDir, { recursive: true, force: true });
      try {
        const restored = restoreSelectionsAfterInstallFailure(selectionSnapshot);
        if (restored.changed) console.error(`cleared partial Asset Selections for ${id} after install failure`);
      } catch (restoreError) {
        console.error(`RECOVERY PROBLEM: Asset Selection cleanup failed for ${id}: ${restoreError.message}`);
      }
      frameworkRestart();
      console.error(`install failed, no previous version — ${id} removed`);
    }
    die(String(e?.message ?? e));
  }
}

// ============================================================
// dev-sync / legacy migration helpers
// ============================================================

function syncStagingPath(root, id) {
  return path.join(root, '.staging', `${id}-dev-sync-${process.pid}-${Date.now()}`);
}

async function cmdDevSync(tarPath, args = []) {
  const shaPath = args.find((arg) => arg.startsWith('--sha256='))?.slice('--sha256='.length)
    ?? `${tarPath}.sha256`;
  const v = await verifyArchive(tarPath, shaPath);
  if (!v.ok) die(`dev-sync verify failed: ${v.error}`);
  const id = v.id;
  const lock = lockPackage(id);
  const root = installedRoot();
  const current = requireReconciled(id);
  if (!current.active) die(`${id} is not installed`);
  if (v.version !== current.active.version) {
    die(`dev-sync version mismatch: active is ${current.active.version}, source archive is ${v.version}; release/install a version change first`);
  }
  const staging = syncStagingPath(root, id);
  const held = `${current.active.path}.dev-sync-held-${process.pid}-${Date.now()}`;
  let moved = false;
  let lockHeld = true;
  try {
    fs.mkdirSync(staging, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', staging]);
    const stagedRoot = path.join(staging, v.top_id);
    if (!fs.existsSync(path.join(stagedRoot, '.git'))) {
      die('dev-sync source must include a Git worktree identity (.git)');
    }
    const sourceIdentity = packageGitIdentity(stagedRoot);
    if (!sourceIdentity.head || !sourceIdentity.branch) {
      die('dev-sync source must have a named branch and HEAD');
    }
    await stopOwnedServices(v.manifest);
    fs.renameSync(current.active.path, held);
    moved = true;
    fs.renameSync(stagedRoot, current.active.path);
    // The Framework reload has its own per-ID queue and acquires the same
    // cross-process lock. Release this CLI lock before asking the running
    // Framework to reload, otherwise the two halves would wait on each other.
    lock.release();
    lockHeld = false;
    const reloaded = await frameworkApi().call('POST', `/api/dev/packages/${id}/reload`);
    if (!reloaded?.ok) {
      throw new Error(`Framework dev reload failed: ${reloaded?.error ?? 'unreachable'}`);
    }
    fs.rmSync(held, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    console.log(JSON.stringify({
      ok: true, operation: 'dev-sync', package_id: id,
      active_path: current.active.path, version: v.version,
      source_git: sourceIdentity, reload: reloaded,
      reconcile: reconcilePackage(id, { frameworkRoot: ROOT }),
    }, null, 2));
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* Best effort. */ }
    if (moved) {
      try {
        let restoreLock = null;
        if (!lockHeld) {
          restoreLock = lockPackage(id);
          lockHeld = true;
        }
        fs.rmSync(current.active.path, { recursive: true, force: true });
        fs.renameSync(held, current.active.path);
        if (restoreLock) {
          restoreLock.release();
          lockHeld = false;
        }
        await frameworkApi().call('POST', `/api/dev/packages/${id}/reload`);
      } catch (restoreError) {
        console.error(`ERROR: dev-sync restore also failed: ${String(restoreError?.message ?? restoreError)}`);
      }
    }
    if (lockHeld) lock.release();
    die(String(error?.message ?? error));
  }
}

function cmdLegacyList(id) {
  const items = id ? legacyWorkspaceCandidates(id) : (() => {
    const ids = new Set();
    for (const root of [process.env.TERMUX_OS_DEV_ROOT, path.join(os.homedir(), 'termux-os-dev', 'packages')].filter(Boolean)) {
      try { for (const name of fs.readdirSync(root)) ids.add(name); } catch { /* Root may not exist. */ }
    }
    return [...ids].sort().flatMap((name) => legacyWorkspaceCandidates(name));
  })();
  console.log(JSON.stringify({ schema: 'termux-os.legacy-workspaces.v1', workspaces: items }, null, 2));
}

async function cmdLegacyArchive(id) {
  const lock = lockPackage(id);
  try {
    const active = readActive(id);
    const activePath = active ? path.join(installedRoot(), id, 'versions', active.active_version) : null;
    const candidates = legacyWorkspaceCandidates(id).filter((item) => !samePathForManager(item.path, activePath));
    if (!candidates.length) die(`${id} has no legacy workspace to archive`);
    const stamp = `${new Date().toISOString().replaceAll(':', '')}-${process.pid}`;
    const destination = path.join(os.homedir(), '.termux-os', 'legacy-workspaces', id, stamp);
    fs.mkdirSync(destination, { recursive: true });
    const archived = [];
    for (const item of candidates) {
      const target = path.join(destination, path.basename(item.path));
      fs.renameSync(item.path, target);
      archived.push({ from: item.path, to: target });
    }
    console.log(JSON.stringify({ ok: true, operation: 'legacy-archive', package_id: id, archived }, null, 2));
  } finally { lock.release(); }
}

function samePathForManager(a, b) {
  try { return Boolean(a && b && fs.realpathSync(a) === fs.realpathSync(b)); }
  catch { return Boolean(a && b && path.resolve(a) === path.resolve(b)); }
}

async function cmdArchiveDevArtifacts(id) {
  const lock = lockPackage(id);
  try {
    const current = requireReconciled(id);
    if (!current.active) die(`${id} is not installed`);
    const changes = new Set((current.git.changes ?? []).filter((item) => item.untracked).map((item) => item.path));
    const files = [];
    const walk = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === '.runtime') continue;
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, next);
        else if (entry.isFile() && changes.has(next)
          && (entry.name.includes('.before-') || entry.name.endsWith('.bak') || entry.name.endsWith('.backup'))) files.push({ full, rel: next });
      }
    };
    walk(current.active.path);
    if (!files.length) {
      console.log(JSON.stringify({ ok: true, operation: 'archive-dev-artifacts', package_id: id, archived: [] }, null, 2));
      return;
    }
    const destination = path.join(os.homedir(), '.termux-os', 'package-archives', id,
      `active-backups-${new Date().toISOString().replaceAll(':', '')}-${process.pid}`);
    const archived = [];
    for (const file of files) {
      const target = path.join(destination, file.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(file.full, target);
      archived.push({ from: file.full, to: target });
    }
    console.log(JSON.stringify({ ok: true, operation: 'archive-dev-artifacts', package_id: id, archived }, null, 2));
  } finally { lock.release(); }
}

function cmdReconcile(id) {
  console.log(JSON.stringify(reconcilePackage(id, { frameworkRoot: ROOT }), null, 2));
}

// ============================================================
// 原包保存与恢复（archive/）
// ============================================================

/** 安装来源。远端下载时由调用方写在 tar 旁的 sidecar 里；本地装则只有路径。 */
function readInstallOrigin(tarPath) {
  try { return JSON.parse(fs.readFileSync(`${tarPath}.origin.json`, 'utf8')); }
  catch { return { kind: 'local_file', path: path.basename(tarPath) }; }
}

// ============================================================
// Local history protection (Development provenance + Git history)
// ============================================================

const PRESERVE_FLAGS = ['--preserve-development', '--preserve-dirty'];
const FORCE_FLAGS = ['--force-discard', '--force-dirty'];

/** A refusal an Agent can branch on: one JSON line on stdout, the human line on stderr. */
function refuse(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, code, detail: message, ...extra }));
  console.error(`ERROR: ${code}: ${message}`);
  process.exit(1);
}

function protectionMode(args) {
  const preserve = args.some((arg) => PRESERVE_FLAGS.includes(arg));
  const force = args.some((arg) => FORCE_FLAGS.includes(arg));
  if (preserve && force) refuse('protection_options_conflict', 'choose either --preserve-development or --force-discard, not both');
  return { preserve, force };
}

/** Local history in a non-active version directory (previous/prunable). Provenance is not its concern. */
function inactiveVersionHistory(pkgDir, version) {
  const dir = path.join(pkgDir, 'versions', version);
  if (!fs.existsSync(path.join(dir, '.git'))) return { local_history: false, available: false };
  let meta = null;
  try {
    for (const name of fs.readdirSync(archiveDir(pkgDir))) {
      if (name.startsWith(`${version}@`) && name.endsWith('.json')) {
        try { meta = JSON.parse(fs.readFileSync(path.join(archiveDir(pkgDir), name), 'utf8')); break; } catch { /* next */ }
      }
    }
  } catch { /* No archive directory. */ }
  const scan = gitHistoryScan(dir, meta?.head ?? null);
  // A Git tree whose release commit is unknown cannot be proven empty of local work.
  return { ...scan, local_history: scan.available ? scan.local_history : true, target: meta?.target ?? TARGET_GENERIC,
    released_head: meta?.head ?? null };
}

function describeProtection(state) {
  const refs = state.git.local_refs.map((ref) => `${ref.ref} (+${ref.commits ?? '?'})`);
  return [
    ...state.reasons_text,
    ...(refs.length ? [`refs: ${refs.join(', ')}`] : []),
    ...(state.git.head ? [`HEAD ${state.git.head.slice(0, 12)} on ${state.git.branch ?? 'detached HEAD'}`] : []),
  ].join('; ');
}

/**
 * Guard a destructive operation on the active version. Returns whether a backup must be made.
 * Refuses by default; `--preserve-development` backs up first, `--force-discard` proceeds.
 */
function guardLocalHistory(state, operation, { preserve, force }) {
  if (!state?.protection_required) return { backup: false };
  if (preserve) return { backup: true };
  if (force) {
    console.log(`WARNING: --force-discard — ${operation} discards: ${describeProtection(state)}; no backup was made`);
    return { backup: false };
  }
  refuse(state.provenance === 'development' ? 'development_backup_required' : 'local_history_present',
    `${operation} would destroy local history (${describeProtection(state)}). `
      + 'Re-run with --preserve-development to back up the complete work tree (.git, branches, stash) first, '
      + 'or --force-discard to discard it.',
    { state: state.state, provenance: state.provenance, protection_reasons: state.protection_reasons,
      local_refs: state.git.local_refs, stash_count: state.git.stash_count });
  return { backup: false };
}

/**
 * Development backup: a private tar of the complete version directory, `.git` included, so
 * branches, commits, the stash and its reflog, deletions and untracked files all come back.
 * A patch or `git checkout` cannot reconstruct those.
 */
function createDevelopmentBackup(versionRoot, meta) {
  const destination = backupRoot(meta.id);
  const stamp = `${new Date().toISOString().replaceAll(':', '')}-${process.pid}`;
  const base = `${meta.version}@${meta.target ?? TARGET_GENERIC}-development-${stamp}`;
  const archive = path.join(destination, `${base}.tar.gz`);
  const partial = `${archive}.part`;
  const metadata = `${archive}.json`;
  const metadataPartial = `${metadata}.part`;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const identity = packageGitIdentity(versionRoot);
  let refs = [];
  try {
    refs = execFileSync('git', ['-C', versionRoot, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((line) => { const [ref, commit] = line.split(' '); return { ref, commit }; });
  } catch { /* A tree without Git is still backed up. */ }
  try {
    execFileSync('tar', ['-czf', partial, '-C', path.dirname(versionRoot), path.basename(versionRoot)], { stdio: 'ignore' });
    const digest = sha256File(partial);
    fs.renameSync(partial, archive);
    fs.writeFileSync(metadataPartial, `${JSON.stringify({
      schema: BACKUP_SCHEMA,
      package_id: meta.id,
      version: meta.version,
      target: meta.target ?? TARGET_GENERIC,
      reason: meta.reason ?? 'manual',
      archive,
      sha256: digest,
      size: fs.statSync(archive).size,
      active_archive_sha256: meta.active_archive_sha256 ?? null,
      head: identity.head,
      branch: identity.branch,
      detached: identity.detached === true,
      released_head: meta.released_head ?? null,
      refs,
      stash_count: meta.state?.git?.stash_count ?? 0,
      local_refs: meta.state?.git?.local_refs ?? [],
      changes: meta.state?.git?.changes ?? [],
      provenance: meta.state?.provenance ?? null,
      development: meta.state?.development ?? null,
      created_at: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(metadataPartial, metadata);
    fs.chmodSync(archive, 0o600);
    return { path: archive, name: path.basename(archive), sha256: digest, metadata };
  } catch (error) {
    for (const file of [partial, archive, metadataPartial, metadata]) fs.rmSync(file, { force: true });
    throw new Error(`development backup failed: ${String(error?.message ?? error)}`);
  }
}

function backupActiveVersion(id, pkgDir, active, state, reason) {
  const release = releaseMetadata(pkgDir, active.active_version, active.active_target ?? TARGET_GENERIC);
  const backup = createDevelopmentBackup(path.join(pkgDir, 'versions', active.active_version), {
    id, version: active.active_version, target: active.active_target ?? TARGET_GENERIC, reason,
    active_archive_sha256: active.archive_sha256 ?? null, released_head: release?.head ?? null, state,
  });
  console.log(`saved development backup for ${id} ${active.active_version} (${backup.sha256.slice(0, 12)}…, ${backup.path})`);
  return backup;
}

function assertPackageId(id) {
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){3,}$/.test(String(id))) refuse('invalid_package_id', `invalid package id: ${id}`);
}

function cmdDevelopmentBackups(id) {
  assertPackageId(id);
  console.log(JSON.stringify({ ok: true, schema: 'termux-os.package-development-backups.v1', package_id: id,
    backups: listDevelopmentBackups(id) }, null, 2));
}

function cmdDevelopmentBackup(id) {
  assertPackageId(id);
  const lock = lockPackage(id);
  try {
    const current = requireReconciled(id);
    if (!current.active) refuse('not_installed', `${id} is not installed`);
    const backup = backupActiveVersion(id, path.join(installedRoot(), id), readActive(id), current.package_state, 'manual');
    console.log(JSON.stringify({ ok: true, operation: 'development-backup', package_id: id, backup }, null, 2));
  } finally { lock.release(); }
}

function cmdActivateDevelopment(id) {
  assertPackageId(id);
  const lock = lockPackage(id);
  try {
    const current = reconcilePackage(id, { frameworkRoot: ROOT });
    if (!current.active) refuse('not_installed', `${id} is not installed`);
    const result = activateDevelopment({
      id, versionRoot: current.active.path, packageRoot: current.active.root, active: readActive(id), conflicts: current.conflicts,
    });
    if (!result.ok) {
      lock.release();
      refuse(result.code, typeof result.detail === 'string' ? result.detail : result.code, { fix: result.fix ?? null });
    }
    console.log(JSON.stringify({ ok: true, operation: 'activate-development', package_id: id, development: result.development,
      state: reconcilePackage(id, { frameworkRoot: ROOT }).package_state }, null, 2));
  } finally { lock.release(); }
}

/** Safe listing check for a backup tar: one top directory named after the version, no links, no escapes. */
function checkBackupEntries(tar, version) {
  let listing;
  try { listing = execFileSync('tar', ['-tvzf', tar], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }); }
  catch (error) { return `backup unreadable: ${String(error?.message ?? error)}`; }
  for (const line of listing.split('\n').filter(Boolean)) {
    const mode = line.trim()[0];
    const name = line.trim().split(/\s+/).slice(5).join(' ').split(' -> ')[0];
    if ('lhbcps'.includes(mode) || line.includes(' link to ')) return `forbidden entry type "${mode}": ${name}`;
    if (name.startsWith('/') || name.split('/').includes('..')) return `unsafe path: ${name}`;
    if (name.split('/')[0] !== version) return `unexpected top-level entry: ${name}`;
  }
  return null;
}

async function cmdRestoreDevelopmentBackup(id, selector, args = []) {
  assertPackageId(id);
  if (!selector || selector.startsWith('--')) refuse('backup_not_found', 'usage: restore-development-backup <package-id> <backup-name|sha256-prefix>');
  const mode = protectionMode(args);
  const lock = lockPackage(id);
  const fail = (code, message) => { lock.release(); refuse(code, message); };
  const root = installedRoot();
  const pkgDir = path.join(root, id);
  const current = requireReconciled(id);
  if (!current.active) fail('not_installed', `${id} is not installed`);
  const active = readActive(id);
  const backup = listDevelopmentBackups(id).find((item) => item.name === selector || String(item.sha256).startsWith(selector));
  if (!backup) fail('backup_not_found', `no development backup of ${id} matches "${selector}"`);
  if (!fs.existsSync(backup.archive)) fail('backup_not_found', `backup archive is missing: ${backup.archive}`);
  if (sha256File(backup.archive) !== backup.sha256) fail('backup_sha_mismatch', `backup ${backup.name} does not match its recorded SHA-256`);
  if (backup.version !== active.active_version || (backup.target ?? TARGET_GENERIC) !== (active.active_target ?? TARGET_GENERIC)) {
    fail('backup_version_mismatch', `backup is ${backup.version}@${backup.target}, active is ${active.active_version}@${active.active_target ?? TARGET_GENERIC}`);
  }
  const unsafe = checkBackupEntries(backup.archive, backup.version);
  if (unsafe) fail('backup_unsafe', unsafe);
  const guard = guardLocalHistory(current.package_state, 'restoring a development backup', mode);
  if (guard.backup) backupActiveVersion(id, pkgDir, active, current.package_state, 'before-backup-restore');

  const versionDir = path.join(pkgDir, 'versions', active.active_version);
  const staging = path.join(root, '.staging', `${id}-backup-restore-${Date.now()}`);
  const held = `${versionDir}.backup-restore-held-${Date.now()}`;
  let moved = false;
  try {
    fs.mkdirSync(staging, { recursive: true });
    execFileSync('tar', ['-xzf', backup.archive, '-C', staging]);
    const restored = path.join(staging, backup.version);
    if (!fs.existsSync(path.join(restored, MANIFEST_FILENAME))) throw new Error('backup has no Package manifest');
    const manifest = JSON.parse(fs.readFileSync(path.join(restored, MANIFEST_FILENAME), 'utf8'));
    if (manifest.id !== id) throw new Error(`backup manifest id ${manifest.id} is not ${id}`);
    let liveManifest = null;
    try { liveManifest = JSON.parse(fs.readFileSync(path.join(versionDir, MANIFEST_FILENAME), 'utf8')); } catch { /* broken is fine */ }
    if (liveManifest) await stopOwnedServices(liveManifest);
    fs.renameSync(versionDir, held); moved = true;
    fs.renameSync(restored, versionDir);
    if (frameworkRestart()) {
      const w = await waitPackageStatus(id, true);
      if (!w.ok) throw new Error(`post-restore check failed: ${w.error}`);
    } else console.log('note: framework.sh not found, skipped restart (dev machine?)');
    fs.rmSync(held, { recursive: true, force: true });
    fs.rmSync(path.join(root, '.staging'), { recursive: true, force: true });
    // A restored development tree is development again, with the baseline it was taken from.
    if (!readDevelopment(pkgDir)) {
      const release = releaseMetadata(pkgDir, active.active_version, active.active_target ?? TARGET_GENERIC);
      writeDevelopment(pkgDir, backup.development ? { ...backup.development, restored_from_backup: backup.name } : {
        package_id: id, base_version: active.active_version, base_target: active.active_target ?? TARGET_GENERIC,
        base_release_sha256: active.archive_sha256 ?? null, base_released_head: release?.head ?? null,
        activated_at: new Date().toISOString(), activated_from_branch: backup.branch ?? null, activated_head: backup.head ?? null,
        restored_from_backup: backup.name,
      });
    }
    lock.release();
    console.log(JSON.stringify({ ok: true, operation: 'restore-development-backup', package_id: id, backup: backup.name,
      state: reconcilePackage(id, { frameworkRoot: ROOT }).package_state }, null, 2));
  } catch (error) {
    fs.rmSync(path.join(root, '.staging'), { recursive: true, force: true });
    if (moved && fs.existsSync(held)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
      fs.renameSync(held, versionDir);
      frameworkRestart();
    }
    fail('backup_restore_failed', String(error?.message ?? error));
  }
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
async function cmdRestore(id, args = []) {
  const mode = protectionMode(args);
  const operationLock = lockPackage(id);
  const current = requireReconciled(id);
  const root = installedRoot();
  const active = readActive(id);
  if (!active) die(`${id} is not installed`);
  const pkgDir = path.join(root, id);
  const version = active.active_version;
  const target = active.active_target ?? TARGET_GENERIC;
  const tar = archiveTarPath(pkgDir, version, target);
  if (!fs.existsSync(tar)) {
    operationLock.release();
    refuse('official_baseline_unavailable', isDevelopmentOnly(active)
      ? `${id} ${version} is development-only: it has never had an official Release, so there is nothing to restore. `
        + 'Nothing was changed. Release and install it to create an official baseline.'
      : `no saved official archive for ${id} ${archiveKey(version, target)}; nothing was changed. `
        + 'Reinstall this version from the catalog to obtain one.');
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

  // The restore replaces the whole active directory, `.git` included. Refuse by default when that
  // would destroy local history or end a Development session without a backup.
  const guard = guardLocalHistory(current.package_state, `restoring ${id} ${version} to the official release`, mode);
  if (guard.backup) backupActiveVersion(id, pkgDir, active, current.package_state, 'restore');

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
    // Official again only when the restored tree is provably the release: HEAD is the released
    // commit and nothing else is present. A failed post-check above never reaches this line.
    const released = releaseMetadata(pkgDir, version, target)?.head ?? null;
    const scan = gitHistoryScan(versionDir, released);
    const official = scan.available && scan.local_history === false && scan.head === released;
    if (official && readDevelopment(pkgDir)) clearDevelopment(pkgDir);
    const state = reconcilePackage(id, { frameworkRoot: ROOT }).package_state;
    console.log(`restored ${id} ${version} [${target}] from saved archive (${state?.summary ?? 'unknown'})`);
    operationLock.release();
    if (scan.worktree === 'modified') {
      console.error(`WARNING: work tree is still not clean after restore: ${scan.changes.length} change(s)`);
      process.exitCode = 1;
    } else if (readDevelopment(pkgDir)) {
      console.error(`WARNING: development provenance kept: the restored tree could not be verified as the release (${scan.reason ?? 'local history'})`);
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
  const reconcile = reconcilePackage(id, { frameworkRoot: ROOT });
  if (!reconcile.active) refuse('not_installed', `${id} is not installed`);
  const ps = reconcile.package_state;
  // One snapshot: state, reason and summary cannot disagree with each other or with the Dev API.
  console.log(JSON.stringify({
    schema: 'termux-os.package-state-report.v1',
    id,
    version: reconcile.active.version,
    target: reconcile.active.target,
    state: reconcile.state,
    reason: reconcile.state_reason,
    summary: reconcile.state_summary,
    provenance: ps?.provenance ?? null,
    development: ps?.development ?? null,
    local_history_present: ps?.local_history_present ?? null,
    protection_required: ps?.protection_required ?? null,
    protection_reasons: ps?.protection_reasons ?? [],
    released_head: ps?.git?.released_head ?? null,
    head_diverged: Boolean(ps?.git?.head && ps?.git?.released_head && ps.git.head !== ps.git.released_head),
    changes: ps?.git?.changes ?? [],
    ignored_paths: ps?.git?.ignored ?? [],
    git: ps?.git ?? null,
    restorable: Boolean(reconcile.archive?.entries?.some((entry) => entry.kind === 'archive'
      && entry.version === reconcile.active.version && (entry.target ?? reconcile.active.target) === reconcile.active.target)),
    development_backups: listDevelopmentBackups(id).length,
    reconcile,
  }, null, 2));
}

// ============================================================
// uninstall <id>（§7：只刪代碼；配置/數據/綁定/Desired 全保留）
// ============================================================
async function cmdUninstall(id, args = []) {
  const mode = protectionMode(args);
  const operationLock = lockPackage(id);
  const current = requireReconciled(id);
  const root = installedRoot();
  const pkgDir = path.join(root, id);
  const active = readActive(id);
  if (!active) { operationLock.release(); console.log(`${id} is not installed (changed=false)`); return; }
  // Every version directory goes, so every one with local history is guarded, not only the active one.
  const others = (() => { try { return fs.readdirSync(path.join(pkgDir, 'versions')); } catch { return []; } })()
    .filter((version) => version !== active.active_version)
    .map((version) => ({ version, history: inactiveVersionHistory(pkgDir, version) }))
    .filter((item) => item.history.local_history);
  const state = current.package_state;
  const combined = others.length && !state.protection_required ? {
    ...state, protection_required: true, reasons_text: [`versions/${others.map((o) => o.version).join(', ')} hold local history`],
  } : state;
  const guard = guardLocalHistory(combined, `uninstalling ${id}`, mode);
  if (guard.backup) {
    if (state.protection_required) backupActiveVersion(id, pkgDir, active, state, 'uninstall');
    for (const item of others) {
      const backup = createDevelopmentBackup(path.join(pkgDir, 'versions', item.version), {
        id, version: item.version, target: item.history.target, reason: 'uninstall', released_head: item.history.released_head,
        state: { git: item.history, provenance: null, development: null },
      });
      console.log(`saved development backup for ${id} ${item.version} (${backup.sha256.slice(0, 12)}…, ${backup.path})`);
    }
  }
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'versions', active.active_version, MANIFEST_FILENAME), 'utf8')); }
  catch { /* 版本目錄壞了也照樣卸載 */ }
  if (manifest) await stopOwnedServices(manifest);
  // 024 §6.3：只摘 active 登記，**payload 一律保留**（無 purge）——大模型重裝一次要幾分鐘，
  // 而且 /sdcard 上的東西不歸安裝器處置。使用方會如實看到 missing_asset，不會退回某個不明模型
  for (const a of manifest?.assets?.provides ?? []) {
    try { clearPayloadSelection(a.id, declarationVariantId(a)); } catch { /* v2 bridge may not exist yet */ }
    if (deactivateAsset(a.id)) console.log(`asset ${a.id}: deactivated (shared payload kept on disk)`);
  }
  const ledger = readPayloadLedger();
  if (!ledger.error && fs.existsSync(payloadLedgerPath())) syncCompatibilityRegistry(ledger);
  // Code, archives and provenance go; the Package's own settings stay where a reinstall finds
  // them. A directory holding only config/ is not an installed Package (no active.json/versions).
  const configDir = path.join(pkgDir, 'config');
  const heldConfig = path.join(root, '.staging', `${id}-config-${Date.now()}`);
  const keepConfig = fs.existsSync(configDir);
  if (keepConfig) { fs.mkdirSync(path.dirname(heldConfig), { recursive: true }); fs.renameSync(configDir, heldConfig); }
  fs.rmSync(pkgDir, { recursive: true, force: true });
  if (keepConfig) {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.renameSync(heldConfig, configDir);
    fs.rmSync(path.join(root, '.staging'), { recursive: true, force: true });
  }
  if (frameworkRestart()) {
    const w = await waitPackageStatus(id, false);
    if (!w.ok) die(`uninstall post-check failed: ${w.error}`);
  }
  operationLock.release();
  console.log(`uninstalled ${id} (was ${active.active_version}); ${keepConfig ? `config kept at ${configDir}` : 'no Package config to keep'}; `
    + 'shared data, bindings and desired state preserved');
}

// ============================================================
// rollback <id>（§8：active ↔ previous 互換；只留兩版本）
// ============================================================
async function cmdRollback(id) {
  const operationLock = lockPackage(id);
  requireReconciled(id);
  const root = installedRoot();
  const active = readActive(id);
  if (!active) die(`${id} is not installed`);
  const prev = active.previous_version;
  if (!prev) { operationLock.release(); refuse('no_previous_release', `${id} has no previous Release to roll back to; nothing was changed`); }
  const prevDir = path.join(root, id, 'versions', prev);
  if (!fs.existsSync(prevDir)) die(`previous version directory missing: versions/${prev}`);
  let currentManifest = null;
  try { currentManifest = JSON.parse(fs.readFileSync(path.join(root, id, 'versions', active.active_version, MANIFEST_FILENAME), 'utf8')); }
  catch { /* 當前版本壞了正是 rollback 的理由 */ }
  if (currentManifest) await stopOwnedServices(currentManifest);
  let prevManifest = null;
  try { prevManifest = JSON.parse(fs.readFileSync(path.join(prevDir, MANIFEST_FILENAME), 'utf8')); } catch { /* 舊版壞了 */ }
  const rollbackSelections = selectionEntriesFor(currentManifest, prevManifest);
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
  // A rollback may remove an Asset variant or leave its old bytes absent. Clear
  // the whole affected Selection slice first; the loop below reselects only
  // old payloads that are actually present and verified.
  try {
    restorePayloadSelections(rollbackSelections.map((entry) => ({ ...entry, selection: null })), {
      expectedGeneration: readPayloadLedger().generation,
    });
  } catch (error) { die(`rollback Asset Selection reconciliation failed: ${error.message}`); }
  // 024 §6.2：Asset 的 rollback = **只切登記指針**，不複製、不重解壓大檔（payload 各版本都還在）
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
    try { recordV2Asset(a, dir, checksums, prevManifest, prevTarget, prevManifest?.targets?.find((t) => t.id === prevTarget) ?? null); }
    catch (error) { console.error(`WARNING: asset ${a.id}: v2 selection bridge failed: ${String(error?.message ?? error)}`); }
    console.log(`asset ${a.id}: registry now points at ${prev} (no bytes copied)`);
  }
  const ledger = readPayloadLedger();
  if (!ledger.error && fs.existsSync(payloadLedgerPath())) syncCompatibilityRegistry(ledger);

  if (frameworkRestart()) {
    const w = await waitPackageStatus(id, true);
    if (!w.ok) die(`rollback post-check failed: ${w.error}`);
  }
  operationLock.release();
  console.log(`rolled back ${id} to ${prev} (previous now ${active.active_version})`);
}

function cmdList() {
  const root = installedRoot();
  let ids = [];
  try { ids = fs.readdirSync(root).filter((d) => !d.startsWith('.')); } catch { /* 空 */ }
  if (!ids.length) { console.log(`(no packages installed under ${root})`); return; }
  for (const id of ids.sort()) {
    const a = readActive(id);
    // An uninstalled Package keeps only config/; that is kept settings, not a broken install.
    if (!a && !fs.existsSync(path.join(root, id, 'versions'))) continue;
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
  case 'install': await cmdInstall(rest[0] ?? die('usage: install <tar> [sha256] [--force-target] [--allow-missing-external] [--preserve-development | --force-discard]'),
    rest[1]?.startsWith('--') ? undefined : rest[1], rest.slice(1)); break;
  case 'uninstall': await cmdUninstall(rest[0] ?? die('usage: uninstall <package-id> [--preserve-development | --force-discard]'), rest.slice(1)); break;
  case 'rollback': await cmdRollback(rest[0] ?? die('usage: rollback <package-id>')); break;
  case 'list': cmdList(); break;
  case 'profile': cmdProfile(); break;
  case 'check': await cmdCheck(rest[0] ?? die('usage: check <tar> [--force-target]'), rest.slice(1)); break;
  case 'check-installed': cmdCheckInstalled(rest[0] ?? die('usage: check-installed <package-id>'), rest.slice(1)); break;
  case 'restore': await cmdRestore(rest[0] ?? die('usage: restore <package-id> [--preserve-development | --force-discard]'), rest.slice(1)); break;
  case 'state': cmdState(rest[0] ?? die('usage: state <package-id>')); break;
  case 'reconcile': cmdReconcile(rest[0] ?? die('usage: reconcile <package-id>')); break;
  case 'dev-sync': await cmdDevSync(rest[0] ?? die('usage: dev-sync <archive.tar.gz> [--sha256=<sidecar>]'), rest.slice(1)); break;
  case 'legacy-list': cmdLegacyList(rest[0] ?? null); break;
  case 'legacy-archive': await cmdLegacyArchive(rest[0] ?? die('usage: legacy-archive <package-id>')); break;
  case 'archive-dev-artifacts': await cmdArchiveDevArtifacts(rest[0] ?? die('usage: archive-dev-artifacts <package-id>')); break;
  case 'dirty-backups':
  case 'development-backups': cmdDevelopmentBackups(rest[0] ?? die('usage: development-backups <package-id>')); break;
  case 'development-backup': cmdDevelopmentBackup(rest[0] ?? die('usage: development-backup <package-id>')); break;
  case 'restore-development-backup': await cmdRestoreDevelopmentBackup(rest[0] ?? die('usage: restore-development-backup <package-id> <backup-name|sha256-prefix> [--preserve-development | --force-discard]'), rest[1], rest.slice(2)); break;
  case 'activate-development': cmdActivateDevelopment(rest[0] ?? die('usage: activate-development <package-id>')); break;
  case 'development-status': cmdState(rest[0] ?? die('usage: development-status <package-id>')); break;
  default:
    console.log('usage: node scripts/package-manager.mjs <pack|verify|install|uninstall|rollback|list|profile|check|check-installed|restore|state|reconcile|dev-sync|legacy-list|legacy-archive|archive-dev-artifacts|activate-development|development-status|development-backup|development-backups|restore-development-backup> ...');
    process.exit(cmd ? 1 : 0);
}
