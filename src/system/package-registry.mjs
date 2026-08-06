/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A configured public Package Registry endpoint and structured Package selections.
 * [OUTPUT]: A cached catalog, pre-download Package details, the full verified Framework version list,
 *           three-stage source resolution, and a streamed archive response.
 * [POS]: src/system/package-registry.mjs in termux-os-framework.
 * [PROTOCOL]: Registry requests accept structured source identifiers only; arbitrary URLs and credentials are forbidden.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE_REGISTRY_SCHEMA = 'termux-os.package-registry.v1';
export const DEFAULT_PACKAGE_REGISTRY_URL = 'https://package.termux-os.com';
export const FRAMEWORK_REGISTRY_TYPE = 'framework';

const SOURCE_RE = /^(?:github|huggingface)$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION_RE = /^(?![vV])[A-Za-z0-9._+@/-]+$/;
const FILE_RE = /^[A-Za-z0-9._/-]+$/;
const UPSTREAM_REF_RE = /^(?![vV])[A-Za-z0-9._+@/-]{1,200}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

let config = {
  baseUrl: DEFAULT_PACKAGE_REGISTRY_URL,
  snapshotPath: null,
  timeoutMs: 30000,
  directTimeoutMs: 6000,
  fetchImpl: (...args) => globalThis.fetch(...args),
};

let state = emptySnapshot();

function errorWithCode(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function normalizedBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw errorWithCode('Package Registry URL is invalid', 'registry_url_invalid'); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw errorWithCode('Package Registry URL must use HTTPS', 'registry_url_insecure');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw errorWithCode('Package Registry URL must be an origin without credentials or a path', 'registry_url_invalid');
  }
  return url.origin;
}

function emptySnapshot() {
  return {
    schema: PACKAGE_REGISTRY_SCHEMA,
    base_url: DEFAULT_PACKAGE_REGISTRY_URL,
    registry_version: null,
    generated_at: null,
    updated_at: null,
    fetched_at: null,
    status: 'not_fetched',
    error: null,
    packages: [],
  };
}

function publicSnapshot(value = state) {
  return {
    schema: PACKAGE_REGISTRY_SCHEMA,
    base_url: value.base_url ?? config.baseUrl,
    registry_version: value.registry_version ?? null,
    generated_at: value.generated_at ?? null,
    updated_at: value.updated_at ?? null,
    fetched_at: value.fetched_at ?? null,
    status: value.status ?? 'not_fetched',
    error: value.error ?? null,
    packages: value.packages ?? [],
  };
}

function publicError(error) {
  return { code: error?.code ?? 'registry_unavailable' };
}

function readCachedSnapshot() {
  if (!config.snapshotPath) return;
  try {
    const value = JSON.parse(fs.readFileSync(config.snapshotPath, 'utf8'));
    if (value?.schema !== PACKAGE_REGISTRY_SCHEMA || !Array.isArray(value.packages)) return;
    state = {
      ...emptySnapshot(),
      ...value,
      base_url: config.baseUrl,
      status: value.fetched_at ? 'ready' : 'not_fetched',
      error: null,
    };
  } catch { /* A missing or corrupt catalog is replaced by the next successful refresh. */ }
}

function writeCachedSnapshot(value) {
  if (!config.snapshotPath) return;
  fs.mkdirSync(path.dirname(config.snapshotPath), { recursive: true, mode: 0o700 });
  const tmp = `${config.snapshotPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, config.snapshotPath);
    fs.chmodSync(config.snapshotPath, 0o600);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function textField(value, label, pattern) {
  if (typeof value !== 'string' || !value || !pattern.test(value)) {
    throw errorWithCode(`${label} is invalid`, 'registry_selection_invalid');
  }
  return value;
}

function normalizeFile(value) {
  if (!value || typeof value !== 'object') throw errorWithCode('Registry file metadata is invalid', 'registry_payload_invalid');
  const name = textField(value.name, 'file name', FILE_RE);
  if (name.startsWith('/') || name.split('/').includes('..')) {
    throw errorWithCode('Registry file path is unsafe', 'registry_payload_invalid');
  }
  const size = value.size == null ? null : Number(value.size);
  const sha256 = value.sha256 == null ? null : String(value.sha256).toLowerCase();
  if (size != null && (!Number.isSafeInteger(size) || size < 1)) {
    throw errorWithCode('Registry file size is invalid', 'registry_payload_invalid');
  }
  if (sha256 != null && !SHA256_RE.test(sha256)) {
    throw errorWithCode('Registry file SHA-256 is invalid', 'registry_payload_invalid');
  }
  return {
    kind: textField(value.kind, 'file kind', /^[A-Za-z0-9_-]+$/),
    name,
    size,
    sha256,
    content_type: typeof value.content_type === 'string' ? value.content_type : null,
  };
}

function normalizePackages(value) {
  if (!Array.isArray(value)) throw errorWithCode('Registry package list is invalid', 'registry_payload_invalid');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw errorWithCode('Registry package entry is invalid', 'registry_payload_invalid');
    const source = textField(item.source, 'package source', SOURCE_RE);
    const repository = textField(item.repository, 'package repository', REPOSITORY_RE);
    if (!Array.isArray(item.versions)) throw errorWithCode('Registry package versions are invalid', 'registry_payload_invalid');
    return {
      source,
      repository,
      package_id: typeof item.package_id === 'string' ? item.package_id : null,
      display_name: typeof item.display_name === 'string' ? item.display_name : repository,
      description: typeof item.description === 'string' ? item.description : null,
      homepage: typeof item.homepage === 'string' ? item.homepage : null,
      publisher: typeof item.publisher === 'string' ? item.publisher : null,
      types: Array.isArray(item.types) ? item.types.filter((value) => typeof value === 'string') : [],
      official: Array.isArray(item.official) ? item.official.filter((value) => typeof value === 'string') : [],
      latest_version: typeof item.latest_version === 'string' ? item.latest_version : null,
      latest_verified_version: typeof item.latest_verified_version === 'string'
        ? item.latest_verified_version : (typeof item.latest_version === 'string' ? item.latest_version : null),
      latest_verified_published_at: typeof item.latest_verified_published_at === 'string'
        ? item.latest_verified_published_at : null,
      versions: item.versions.map((version) => {
        if (!version || typeof version !== 'object') throw errorWithCode('Registry version entry is invalid', 'registry_payload_invalid');
        const versionName = textField(version.version, 'package version', VERSION_RE);
        if (!Array.isArray(version.files)) throw errorWithCode('Registry version files are invalid', 'registry_payload_invalid');
        const upstreamRef = typeof version.upstream_ref === 'string' ? version.upstream_ref : null;
        if (upstreamRef !== null && !UPSTREAM_REF_RE.test(upstreamRef)) {
          throw errorWithCode('Package upstream ref must not start with v', 'registry_payload_invalid');
        }
        return {
          version: versionName,
          status: typeof version.status === 'string' ? version.status : null,
          upstream_ref: upstreamRef,
          published_at: typeof version.published_at === 'string' ? version.published_at : null,
          details: version.details && typeof version.details === 'object' ? version.details : null,
          /**
           * 依賴索引：一個歸檔一條，記它 provides／depends 什麼。
           *
           * ⚠ 這個正規化器是**白名單**——沒列出的欄位一律丟掉。加了索引卻忘了這一行，
           * 表現不是報錯而是「設備上永遠查不到任何提供方」：Registry 答得好好的，
           * 快照裡卻什麼都沒有，而兩邊看起來都很正常。實測就是這樣卡了一次。
           */
          packages: Array.isArray(version.packages)
            ? version.packages.filter((entry) => entry && typeof entry === 'object').map((entry) => ({
              file: typeof entry.file === 'string' ? entry.file : null,
              package_id: typeof entry.package_id === 'string' ? entry.package_id : null,
              provides: Array.isArray(entry.provides) ? entry.provides : [],
              depends: Array.isArray(entry.depends) ? entry.depends : [],
            }))
            : [],
          files: version.files.map(normalizeFile),
        };
      }),
    };
  });
}

function timeoutSignal(timeoutMs = config.timeoutMs) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
}

async function requestJson(endpoint, body) {
  let response;
  try {
    response = await config.fetchImpl(`${config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(),
    });
  } catch (cause) {
    throw errorWithCode('Package Registry is unreachable', 'registry_unavailable', { cause });
  }
  let value;
  try { value = await response.json(); } catch (cause) {
    throw errorWithCode('Package Registry returned invalid JSON', 'registry_payload_invalid', { cause });
  }
  if (!response.ok || value?.ok === false) {
    throw errorWithCode('Package Registry rejected the request', 'registry_upstream_rejected', { upstreamStatus: response.status });
  }
  return value;
}

function assertSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw errorWithCode('Package selection is required', 'registry_selection_invalid');
  }
  const source = textField(value.source, 'source', SOURCE_RE);
  const repository = textField(value.repository, 'repository', REPOSITORY_RE);
  const version = textField(value.version, 'version', VERSION_RE);
  const kind = textField(value.kind, 'file kind', /^source_tar$/);
  const file = textField(value.file, 'file', FILE_RE);
  if (file.startsWith('/') || file.split('/').includes('..') || !file.endsWith('.tar.gz')) {
    throw errorWithCode('Package source archive name is invalid', 'registry_selection_invalid');
  }
  return { source, repository, version, kind, file };
}

function listedFile(selection, requiredType = null) {
  const project = state.packages.find((item) => item.source === selection.source && item.repository === selection.repository);
  const version = project?.versions.find((item) => item.version === selection.version);
  const file = version?.files.find((item) => item.kind === selection.kind && item.name === selection.file);
  if (!project || !version || !file) {
    throw errorWithCode('Package selection is not present in the cached Registry catalog', 'registry_selection_not_listed');
  }
  if (requiredType && !project.types.includes(requiredType)) {
    throw errorWithCode(`Registry project is not a ${requiredType}`, 'registry_project_type_mismatch');
  }
  if (!Number.isSafeInteger(file.size) || !SHA256_RE.test(file.sha256 ?? '')) {
    throw errorWithCode('Registry file is not pinned with size and SHA-256', 'registry_file_unpinned');
  }
  return { project, version, file };
}

function versionKey(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionKey(left); const b = versionKey(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function frameworkRegistryInfo({ repository, currentVersion } = {}) {
  const project = state.packages.find((item) => item.source === 'github'
    && (!repository || item.repository === repository)
    && item.types.includes(FRAMEWORK_REGISTRY_TYPE));
  if (!project) return {
    available: false, repository: repository ?? null, current_version: currentVersion ?? null,
    latest_version: null, update_available: false, selection: null,
  };
  const latest = project.latest_verified_version || project.latest_version;
  const version = project.versions.find((item) => item.version === latest);
  const file = version?.files.find((item) => item.kind === 'source_tar' && item.name.endsWith('.tar.gz'));
  const updateAvailable = Boolean(latest && currentVersion && compareVersions(latest, currentVersion) > 0);
  return {
    available: Boolean(latest && file),
    repository: project.repository,
    display_name: project.display_name,
    homepage: project.homepage,
    current_version: currentVersion ?? null,
    latest_version: latest ?? null,
    latest_published_at: project.latest_verified_published_at ?? null,
    update_available: updateAvailable,
    selection: latest && file ? {
      source: 'github', repository: project.repository, version: latest, upstream_ref: version.upstream_ref,
      kind: 'source_tar', file: file.name,
    } : null,
    file: file ?? null,
    // 全部已驗證版本，而不只是 latest。「已是最新」不等於「無事可做」——
    // 檔案損壞要能重裝當前版本，出問題要能裝回指定的舊版；
    // last-good 只有一格，連更兩次就夠不著更早的版本了。
    versions: project.versions
      .map((item) => {
        // status 缺席代表 Registry 沒表態（舊目錄），沿用 latest 路徑的寬鬆處理；
        // 明確標成非 verified 的版本不列出，免得使用者按下去才被安裝器拒絕。
        if (item.status && item.status !== 'verified') return null;
        const archive = item.files.find((f) => f.kind === 'source_tar' && f.name.endsWith('.tar.gz'));
        if (!archive) return null;
        return {
          version: item.version,
          published_at: item.published_at ?? null,
          size: archive.size ?? null,
          sha256: archive.sha256 ?? null,
          // 相對當前版本的方向，讓 UI 不必自己再實作一次版本比較
          relation: currentVersion
            ? (compareVersions(item.version, currentVersion) > 0 ? 'newer'
              : compareVersions(item.version, currentVersion) < 0 ? 'older' : 'current')
            : 'unknown',
          selection: {
            source: 'github', repository: project.repository, version: item.version,
            upstream_ref: item.upstream_ref, kind: 'source_tar', file: archive.name,
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => compareVersions(b.version, a.version)),
  };
}

function remoteFilename(selection) {
  return `${selection.source}-${selection.repository.replace('/', '-')}-${selection.version}-${selection.file}`
    .replace(/[^A-Za-z0-9._-]/g, '_');
}

function githubSourceUrls(selection, version) {
  if (selection.source !== 'github') return null;
  const upstreamRef = typeof version.upstream_ref === 'string'
    ? (UPSTREAM_REF_RE.test(version.upstream_ref) ? version.upstream_ref : null)
    : VERSION_RE.test(selection.version) ? selection.version : null;
  if (!upstreamRef) return null;
  const encodedRepository = selection.repository.split('/').map(encodeURIComponent).join('/');
  const encodedRef = encodeURIComponent(upstreamRef);
  return {
    upstream_ref: upstreamRef,
    source_url: `https://github.com/${encodedRepository}/archive/refs/tags/${encodedRef}.tar.gz`,
    release_url: `https://github.com/${encodedRepository}/releases/tag/${encodedRef}`,
  };
}

function attemptSummary(stage, error) {
  return {
    stage,
    code: error?.code ?? `${stage}_failed`,
    detail: String(error?.message ?? error),
  };
}

async function responseArchive(url, listed, stage, options = {}) {
  let response;
  try {
    response = await config.fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'application/gzip' },
      signal: timeoutSignal(options.timeoutMs),
    });
  } catch (cause) {
    throw errorWithCode(`${stage} archive download failed`, `${stage}_download_failed`, { cause });
  }
  if (!response.ok) {
    throw errorWithCode(`${stage} did not return the selected archive`, `${stage}_download_failed`, { upstreamStatus: response.status });
  }
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader == null || contentLengthHeader === '' ? null : Number(contentLengthHeader);
  if (contentLength != null && Number.isSafeInteger(contentLength) && contentLength !== listed.file.size) {
    try { await response.body?.cancel(); } catch { /* The response is discarded after the size gate. */ }
    throw errorWithCode(`${stage} archive size does not match its metadata`, `${stage}_metadata_mismatch`, {
      expectedSize: listed.file.size,
      actualSize: contentLength,
    });
  }
  return response;
}

async function downloadGithubArchive(urls, listed) {
  let probe;
  try {
    probe = await config.fetchImpl(urls.source_url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { Accept: 'application/gzip' },
      signal: timeoutSignal(config.directTimeoutMs),
    });
  } catch (cause) {
    throw errorWithCode('GitHub direct source is unreachable', 'github_direct_unavailable', { cause });
  }
  if (!probe.ok) {
    throw errorWithCode('GitHub direct source did not respond successfully', 'github_direct_unavailable', { upstreamStatus: probe.status });
  }
  return responseArchive(urls.source_url, listed, 'github_direct');
}

export function configurePackageRegistry(options = {}) {
  config = {
    baseUrl: normalizedBaseUrl(options.baseUrl ?? DEFAULT_PACKAGE_REGISTRY_URL),
    snapshotPath: options.snapshotPath ? path.resolve(options.snapshotPath) : null,
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000,
    directTimeoutMs: Number(options.directTimeoutMs) > 0 ? Number(options.directTimeoutMs) : 6000,
    fetchImpl: typeof options.fetchImpl === 'function' ? options.fetchImpl : (...args) => globalThis.fetch(...args),
  };
  state = { ...emptySnapshot(), base_url: config.baseUrl };
  readCachedSnapshot();
  return packageRegistrySnapshot();
}

export function packageRegistrySnapshot() {
  return publicSnapshot();
}

export async function refreshPackageRegistry() {
  try {
    const body = await requestJson('/list', {});
    const next = {
      schema: PACKAGE_REGISTRY_SCHEMA,
      base_url: config.baseUrl,
      registry_version: Number.isSafeInteger(Number(body.registry_version)) ? Number(body.registry_version) : null,
      generated_at: typeof body.generated_at === 'string' ? body.generated_at : null,
      updated_at: typeof body.updated_at === 'string' ? body.updated_at : null,
      fetched_at: new Date().toISOString(),
      status: 'ready',
      error: null,
      packages: normalizePackages(body.packages),
    };
    writeCachedSnapshot(next);
    state = next;
    return packageRegistrySnapshot();
  } catch (error) {
    state = {
      ...state,
      status: state.fetched_at ? 'stale' : 'unavailable',
      error: publicError(error),
    };
    throw error;
  }
}

function detailsSelection(value) {
  const selection = assertSelection(value);
  return selection;
}

export async function packageRegistryDetails(selectionInput) {
  const selection = detailsSelection(selectionInput);
  const body = await requestJson('/details', selection);
  if (!body.details || typeof body.details !== 'object') {
    throw errorWithCode('Package Registry returned no public Package details', 'registry_details_missing');
  }
  return body;
}

export function packageRegistryContainsSha256(sha256) {
  const wanted = String(sha256 ?? '').toLowerCase();
  if (!SHA256_RE.test(wanted)) return false;
  return state.packages.some((project) => project.versions.some((version) =>
    version.files.some((file) => String(file.sha256 ?? '').toLowerCase() === wanted)));
}

/**
 * 按 Package ID 在**已快取的目錄**裡找一個可安裝的最新版本。
 *
 * ⚠ 只讀快取，不發網路請求：安裝預檢會對每個缺席的依賴問一次，而預檢必須是
 * 一次可以立刻回答的判斷。目錄陳舊的處理方式是讓使用者按刷新，不是讓預檢卡住。
 *
 * @returns `{ package_id, repository, source, version, size, sha256, kind, file }` 或 `null`
 */
/** 一個候選歸檔 → 下載坐標。`archiveName` 缺席時退回該版本唯一的 source_tar。 */
function downloadCoordinates(project, version, archiveName, packageId) {
  const files = version.files.filter((item) => item.kind === 'source_tar' && item.name.endsWith('.tar.gz'));
  // ⚠ 一個版本可以有多個歸檔（SenseVoice 1.0.0 下同時有可移植圖與兩個機型檔 ctx）。
  //    按名字挑；挑不中時只有在**唯一**一個候選時才敢用它，否則寧可說不知道——
  //    猜錯的後果是裝上一個看起來對、其實是別的機型檔的包。
  const file = (archiveName && files.find((item) => item.name === archiveName))
    ?? (files.length === 1 ? files[0] : null);
  if (!file) return null;
  return {
    package_id: packageId,
    source: project.source,
    repository: project.repository,
    version: version.version,
    kind: 'source_tar',
    file: file.name,
    size: file.size ?? null,
    sha256: file.sha256 ?? null,
  };
}

/** A version is installable only if it actually carries a package archive. */
const hasArchive = (version) => (version.files ?? [])
  .some((item) => item.kind === 'source_tar' && String(item.name ?? '').endsWith('.tar.gz'));

/**
 * The newest version of this project that can actually be installed.
 *
 * ⚠ `latest_version` is not that question. One repository can host both package
 * archives and the model files those packages point at, and a remote model file is
 * registered under its immutable commit sha — so a project's newest "version" is
 * routinely a 40-character sha whose entry contains no archive at all. Resolving a
 * dependency to it reports the package as missing from the catalog while every
 * installable version sits right there in the list.
 *
 * So: prefer the declared latest when it is installable, otherwise take the newest
 * version that is. Falling back to the last entry regardless of contents is what
 * turned a data-shape quirk into "this package does not exist".
 */
const latestVersionOf = (project) => {
  const declared = project.versions.find((item) => item.version === project.latest_version);
  if (declared && hasArchive(declared)) return declared;
  const installable = project.versions.filter(hasArchive);
  if (installable.length) {
    return installable.slice().sort((a, b) => compareVersions(a.version, b.version)).at(-1);
  }
  return declared ?? project.versions.at(-1);
};

export function packageRegistryFindByPackageId(packageId) {
  const wanted = String(packageId ?? '').trim();
  if (!wanted) return null;
  const project = state.packages.find((item) => item.package_id === wanted);
  if (!project) return null;
  const version = latestVersionOf(project);
  if (!version) return null;
  // 索引記得哪個歸檔是這個 package_id 的；沒有索引時退回唯一候選。
  const indexed = (version.packages ?? []).find((entry) => entry.package_id === wanted);
  return downloadCoordinates(project, version, indexed?.file, wanted);
}

/**
 * 誰提供這個 Capability／Asset。
 *
 * ⭐ 這是「缺一個能力」與「裝這個包就行」之間唯一缺的一步。在此之前，一個
 * Capability 依賴只說得出一種能力的名字，而沒有任何地方記得哪個包供應它——
 * 於是解析停在 `no provider registered`，而那句話對使用者不可行動。
 *
 * ⚠ 有多個提供方時**不猜**。返回全部候選，由調用方決定要不要問人。隨手挑第一個
 * 會讓「裝上了但不是我要的那個」變成一種安靜的失敗。
 */
export function packageRegistryFindProviders(capabilityId, kind = null) {
  const wanted = String(capabilityId ?? '').trim();
  if (!wanted) return [];
  const found = [];
  for (const project of state.packages) {
    const version = latestVersionOf(project);
    for (const entry of version?.packages ?? []) {
      const hit = (entry.provides ?? []).some((item) => item.id === wanted
        && (kind === null || item.kind === kind));
      if (!hit) continue;
      const coordinates = downloadCoordinates(project, version, entry.file, entry.package_id ?? null);
      if (coordinates) found.push(coordinates);
    }
  }
  return found;
}

async function downloadSelectedFromRegistry(selectionInput, requiredType = null) {
  const selection = assertSelection(selectionInput);
  const listed = listedFile(selection, requiredType);
  const checked = await requestJson('/check', selection);
  const checkedProject = checked.project;
  const checkedVersion = checked.version;
  const checkedFile = checked.file;
  if (checkedProject?.source !== selection.source || checkedProject?.repository !== selection.repository
    || checkedVersion?.version !== selection.version || checkedFile?.kind !== selection.kind
    || checkedFile?.name !== selection.file || String(checkedFile.sha256).toLowerCase() !== listed.file.sha256
    || Number(checkedFile.size) !== listed.file.size) {
    throw errorWithCode('Registry check metadata changed or does not match the catalog', 'registry_metadata_mismatch');
  }

  const params = new URLSearchParams(selection);
  const response = await responseArchive(`${config.baseUrl}/download?${params}`, listed, 'registry');
  return {
    response,
    filename: remoteFilename(selection),
    expected_size: listed.file.size,
    expected_sha256: listed.file.sha256,
    origin: {
      registry: config.baseUrl,
      source: selection.source,
      repository: selection.repository,
      version: selection.version,
      kind: selection.kind,
      file: selection.file,
      registry_version: state.registry_version,
      path: 'termux_os_registry',
    },
    project: listed.project,
    version: listed.version,
    file: listed.file,
  };
}

async function downloadSelectedWithFallback(selectionInput, requiredType = null) {
  const selection = assertSelection(selectionInput);
  const listed = listedFile(selection, requiredType);
  const urls = githubSourceUrls(selection, listed.version);
  const attempts = [];

  if (urls) {
    try {
      const response = await downloadGithubArchive(urls, listed);
      return {
        response,
        filename: remoteFilename(selection),
        expected_size: listed.file.size,
        expected_sha256: listed.file.sha256,
        origin: {
          path: 'github_direct',
          source: selection.source,
          repository: selection.repository,
          version: selection.version,
          upstream_ref: urls.upstream_ref,
          source_url: urls.source_url,
          release_url: urls.release_url,
        },
        project: listed.project,
        version: listed.version,
        file: listed.file,
      };
    } catch (error) {
      attempts.push(attemptSummary('github_direct', error));
    }
  }

  try {
    const registryResult = await downloadSelectedFromRegistry(selection, requiredType);
    registryResult.origin = {
      ...registryResult.origin,
      ...(urls ? { fallback_from: 'github_direct', source_url: urls.source_url, release_url: urls.release_url } : {}),
    };
    return registryResult;
  } catch (error) {
    attempts.push(attemptSummary('termux_os_registry', error));
    throw errorWithCode(
      urls
        ? 'GitHub direct download and Termux-OS Registry download failed; download the GitHub Release manually'
        : 'Package Registry download failed; install the verified archive manually',
      'download_fallback_exhausted',
      {
        manual_url: urls?.release_url ?? null,
        source_url: urls?.source_url ?? null,
        attempts,
      },
    );
  }
}

export async function downloadPackageFromRegistry(selectionInput) {
  return downloadSelectedWithFallback(selectionInput);
}

export async function downloadFrameworkFromRegistry(selectionInput) {
  return downloadSelectedWithFallback(selectionInput, FRAMEWORK_REGISTRY_TYPE);
}

if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'framework-package-registry-'));
  const payload = Buffer.from('registry-source-archive');
  const actualSha = crypto.createHash('sha256').update(payload).digest('hex');
  const selected = { source: 'github', repository: 'example/package', version: '0.1.0', kind: 'source_tar', file: 'source.tar.gz' };
  const frameworkSelected = { source: 'github', repository: 'example/framework', version: '0.2.0', kind: 'source_tar', file: 'source.tar.gz' };
  const list = {
    ok: true,
    registry_version: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
    packages: [{
      source: selected.source, repository: selected.repository, display_name: 'Example Package',
      versions: [{ version: selected.version, upstream_ref: selected.version, status: 'verified', files: [{ kind: selected.kind, name: selected.file, size: payload.length, sha256: actualSha }] }],
      types: ['service'],
    }, {
      source: frameworkSelected.source, repository: frameworkSelected.repository, display_name: 'Example Framework',
      types: ['framework'], latest_version: frameworkSelected.version, latest_verified_version: frameworkSelected.version,
      versions: [
        { version: frameworkSelected.version, status: 'verified', published_at: '2026-01-02T00:00:00.000Z', files: [{ kind: frameworkSelected.kind, name: frameworkSelected.file, size: payload.length, sha256: actualSha }] },
        { version: '0.1.0', status: 'verified', published_at: '2026-01-01T00:00:00.000Z', files: [{ kind: frameworkSelected.kind, name: frameworkSelected.file, size: payload.length, sha256: actualSha }] },
        { version: '0.3.0', status: 'pending', published_at: '2026-01-03T00:00:00.000Z', files: [{ kind: frameworkSelected.kind, name: frameworkSelected.file, size: payload.length, sha256: actualSha }] },
      ],
    }],
  };
  configurePackageRegistry({
    baseUrl: 'https://registry.example.test',
    snapshotPath: path.join(tmp, 'snapshot.json'),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      if (pathname === '/list') return new Response(JSON.stringify(list), { status: 200 });
      if (pathname === '/check') {
        const body = JSON.parse(options.body);
        const choice = body.repository === frameworkSelected.repository ? frameworkSelected : selected;
        return new Response(JSON.stringify({
          ok: true,
          project: { source: choice.source, repository: choice.repository },
          version: { version: choice.version },
          file: { kind: choice.kind, name: choice.file, size: payload.length, sha256: actualSha },
        }), { status: 200 });
      }
      if (parsed.hostname === 'github.com') {
        if (options.method === 'HEAD') return new Response(null, { status: 200 });
        return new Response(payload, { status: 200, headers: { 'Content-Length': String(payload.length) } });
      }
      return new Response(payload, { status: 200, headers: { 'Content-Length': String(payload.length) } });
    },
  });
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const snapshot = await refreshPackageRegistry();
  test('registry snapshot is cached', snapshot.status === 'ready' && snapshot.packages.length === 2);
  let prefixedVersionRejected = false;
  try { await downloadPackageFromRegistry({ ...selected, version: ['v', '0.1.0'].join('') }); }
  catch (error) { prefixedVersionRejected = error.code === 'registry_selection_invalid'; }
  test('leading-v version is rejected', prefixedVersionRejected);
  const result = await downloadPackageFromRegistry(selected);
  test('download selection remains structured', result.filename.endsWith('.tar.gz') && result.expected_size === payload.length);
  test('download body is returned for Package Manager streaming', Buffer.compare(Buffer.from(await result.response.arrayBuffer()), payload) === 0);
  test('file hash metadata is checked', result.expected_sha256 === actualSha);
  test('GitHub direct source is preferred', result.origin.path === 'github_direct'
    && result.origin.source_url.endsWith('/archive/refs/tags/0.1.0.tar.gz')
    && result.origin.release_url.endsWith('/releases/tag/0.1.0'));
  const frameworkInfo = frameworkRegistryInfo({ repository: frameworkSelected.repository, currentVersion: '0.1.0' });
  test('Framework catalog exposes a newer typed release', frameworkInfo.available && frameworkInfo.update_available
    && frameworkInfo.selection?.version === frameworkSelected.version);
  // 版本列表是「已是最新時這頁還能做什麼」的基礎：重裝當前版本、裝回舊版。
  const versionList = frameworkInfo.versions ?? [];
  test('Framework catalog lists every verified version, newest first',
    versionList.map((item) => item.version).join(',') === `${frameworkSelected.version},0.1.0`);
  test('each listed version carries its direction relative to the running one',
    versionList[0].relation === 'newer' && versionList[1].relation === 'current');
  test('a listed version can be installed directly from its own selection',
    versionList[1].selection?.version === '0.1.0' && versionList[1].selection?.kind === 'source_tar');
  test('versions the Registry has not verified are not offered',
    !versionList.some((item) => item.version === '0.3.0'));
  const frameworkResult = await downloadFrameworkFromRegistry(frameworkSelected);
  test('Framework download requires the framework project type', frameworkResult.expected_sha256 === actualSha);
  let typeRejected = false;
  try { await downloadFrameworkFromRegistry(selected); } catch (error) { typeRejected = error.code === 'registry_project_type_mismatch'; }
  test('ordinary Package cannot use the Framework download path', typeRejected);

  configurePackageRegistry({
    baseUrl: 'https://registry.example.test',
    snapshotPath: path.join(tmp, 'snapshot-fallback.json'),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'github.com') throw new Error('direct path blocked');
      if (parsed.pathname === '/list') return new Response(JSON.stringify(list), { status: 200 });
      if (parsed.pathname === '/check') return new Response(JSON.stringify({
        ok: true,
        project: { source: selected.source, repository: selected.repository },
        version: { version: selected.version },
        file: { kind: selected.kind, name: selected.file, size: payload.length, sha256: actualSha },
      }), { status: 200 });
      return new Response(payload, { status: 200, headers: { 'Content-Length': String(payload.length) } });
    },
  });
  await refreshPackageRegistry();
  const fallbackResult = await downloadPackageFromRegistry(selected);
  test('Registry is the second-stage fallback', fallbackResult.origin.path === 'termux_os_registry'
    && fallbackResult.origin.fallback_from === 'github_direct');

  /**
   * ⭐ 一个仓库同时托管包归档与模型文件时，模型文件按 40 位 commit sha 登记，
   * 于是项目的 `latest_version` 常常是一个**没有归档**的 sha。照它解析依赖，
   * 会把一个每个可安装版本都在列表里的包报成「不在目录里」——真机上就是这样炸的。
   */
  {
    const withModelRevisions = {
      source: 'huggingface',
      repository: 'owner/assets',
      package_id: 'github.example.asset.thing',
      display_name: 'Thing',
      types: ['asset'],
      versions: [
        { version: '1.0.0', files: [{ kind: 'source_tar', name: 'thing-1.0.0.tar.gz', size: 10, sha256: 'a'.repeat(64) }] },
        { version: '3.1.0', files: [{ kind: 'source_tar', name: 'thing-3.1.0.tar.gz', size: 10, sha256: 'b'.repeat(64) }] },
        { version: 'e'.repeat(40), files: [{ kind: 'model_file', name: 'ctx/model.bin', size: 10, sha256: 'c'.repeat(64) }] },
      ],
      latest_version: 'e'.repeat(40),
    };
    state = { ...emptySnapshot(), status: 'ready', packages: [withModelRevisions] };
    const found = packageRegistryFindByPackageId('github.example.asset.thing');
    test('a model-file revision is never resolved as the installable version',
      found !== null && found.version === '3.1.0' && found.file === 'thing-3.1.0.tar.gz');

    state = { ...emptySnapshot(), status: 'ready', packages: [{ ...withModelRevisions, latest_version: '1.0.0' }] };
    test('a declared latest that does carry an archive is still honoured',
      packageRegistryFindByPackageId('github.example.asset.thing')?.version === '1.0.0');

    state = { ...emptySnapshot(), status: 'ready', packages: [{ ...withModelRevisions,
      versions: [withModelRevisions.versions[2]] }] };
    test('a project with no archive at all resolves to nothing, not to a model file',
      packageRegistryFindByPackageId('github.example.asset.thing') === null);
  }

  configurePackageRegistry({
    baseUrl: 'https://registry.example.test',
    snapshotPath: path.join(tmp, 'snapshot-manual.json'),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/list') return new Response(JSON.stringify(list), { status: 200 });
      throw new Error('all network paths blocked');
    },
  });
  await refreshPackageRegistry();
  let manualFallback = false;
  try { await downloadPackageFromRegistry(selected); } catch (error) {
    manualFallback = error.code === 'download_fallback_exhausted'
      && error.manual_url.endsWith('/releases/tag/0.1.0')
      && error.attempts.length === 2;
  }
  test('manual GitHub Release fallback is structured', manualFallback);
  test('snapshot is private-file mode', (fs.statSync(path.join(tmp, 'snapshot.json')).mode & 0o777) === 0o600);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
