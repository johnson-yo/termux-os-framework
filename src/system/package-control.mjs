/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/package-control.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveInstalledPackages } from '../packages/installed-root.mjs';
import { getPackagePorts } from './port-registry.mjs';
import { isPackageEnabled } from './package-settings.mjs';
import { nodeExecutable } from './node-runtime.mjs';
import {
  ACTIVE_JOB_STATUSES, assertId, createDetachedJobStore, now, processAlive, randomId, readJson, writeJson,
} from './job-store.mjs';

const JOB_SCHEMA = 'termux-os.package-job.v1';
const UPLOAD_SCHEMA = 'termux-os.package-upload.v1';
const SNAPSHOT_SCHEMA = 'termux-os.package-manager.v1';
const ACTIONS = new Set(['check', 'install', 'rollback', 'uninstall']);
const ID_RE = /^[\w.@-]+$/;

let config = {
  root: '',
  frameworkRoot: '',
  installedRoot: '',
  maxUploadBytes: 1024 * 1024 * 1024,
};

const dirs = () => ({
  uploads: path.join(config.root, 'uploads'),
  jobs: path.join(config.root, 'jobs'),
  history: path.join(config.root, 'history.v1.jsonl'),
  lock: path.join(config.root, 'job.lock'),
});

const ensure = () => {
  const d = dirs();
  fs.mkdirSync(d.uploads, { recursive: true });
  fs.mkdirSync(d.jobs, { recursive: true });
  return d;
};

const uploadMetaPath = (id) => path.join(dirs().uploads, `${id}.json`);
const jobStore = () => createDetachedJobStore({ dir: dirs().jobs, idPattern: ID_RE });
const packageId = (value, label = 'id') => assertId(value, label, ID_RE);

const publicUpload = (u) => u && ({
  schema: u.schema,
  id: u.id,
  original_name: u.original_name,
  origin: u.origin ?? null,
  size: u.size,
  sha256: u.sha256,
  status: u.status,
  identity: u.identity ?? null,
  preflight: u.preflight ?? null,
  job_id: u.job_id ?? null,
  created_at: u.created_at,
  updated_at: u.updated_at,
});

export function configurePackageControl(opts) {
  config = {
    root: path.resolve(opts.root),
    frameworkRoot: path.resolve(opts.frameworkRoot),
    installedRoot: path.resolve(opts.installedRoot),
    maxUploadBytes: Number(opts.maxUploadBytes) > 0 ? Number(opts.maxUploadBytes) : 1024 * 1024 * 1024,
  };
  ensure();
  recoverPackageJobs();
}

function normalizedArchiveName(filename) {
  let decoded;
  try { decoded = decodeURIComponent(String(filename ?? '')); } catch { decoded = String(filename ?? ''); }
  const original = path.basename(decoded).replace(/[\x00-\x1f\x7f]/g, '');
  if (!original.endsWith('.tar.gz')) {
    throw Object.assign(new Error('package archive must end in .tar.gz'), { code: 'invalid_archive_name' });
  }
  return original;
}

async function storePackageStream(stream, filename, {
  declaredSize = null,
  expectedSize = null,
  expectedSha256 = null,
  origin = null,
  onTooLarge = null,
} = {}) {
  ensure();
  const original = normalizedArchiveName(filename);
  const declared = Number(declaredSize);
  const expected = expectedSize == null ? null : Number(expectedSize);
  const expectedHash = expectedSha256 == null ? null : String(expectedSha256).toLowerCase();
  if (Number.isSafeInteger(declared) && declared > config.maxUploadBytes) {
    throw Object.assign(new Error(`upload exceeds ${config.maxUploadBytes} bytes`), { code: 'upload_too_large' });
  }
  if (expected != null && (!Number.isSafeInteger(expected) || expected < 1)) {
    throw Object.assign(new Error('remote archive size metadata is invalid'), { code: 'download_metadata_invalid' });
  }
  if (expected != null && expected > config.maxUploadBytes) {
    throw Object.assign(new Error(`download exceeds ${config.maxUploadBytes} bytes`), { code: 'upload_too_large' });
  }
  if (expectedHash != null && !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw Object.assign(new Error('remote archive SHA-256 metadata is invalid'), { code: 'download_metadata_invalid' });
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw Object.assign(new Error('archive response body is unavailable'), { code: 'download_body_missing' });
  }

  const id = randomId('upload');
  const archivePath = path.join(dirs().uploads, `${id}.tar.gz`);
  const partial = `${archivePath}.partial`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  let fd;
  try {
    fd = fs.openSync(partial, 'wx', 0o600);
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > config.maxUploadBytes) {
        onTooLarge?.();
        throw Object.assign(new Error(`upload exceeds ${config.maxUploadBytes} bytes`), { code: 'upload_too_large' });
      }
      hash.update(bytes);
      fs.writeSync(fd, bytes);
    }
    fs.closeSync(fd); fd = null;
    if (!size) throw Object.assign(new Error('empty upload'), { code: 'empty_upload' });
    if (expected != null && size !== expected) {
      throw Object.assign(new Error(`download size mismatch: expected ${expected}, got ${size}`), { code: 'download_size_mismatch' });
    }
    fs.renameSync(partial, archivePath);
  } catch (error) {
    if (fd !== undefined && fd !== null) fs.closeSync(fd);
    fs.rmSync(partial, { force: true });
    fs.rmSync(archivePath, { force: true });
    throw error;
  }

  const sha256 = hash.digest('hex');
  if (expectedHash != null && sha256 !== expectedHash) {
    fs.rmSync(archivePath, { force: true });
    throw Object.assign(new Error(`download checksum mismatch: expected ${expectedHash}, got ${sha256}`), { code: 'download_checksum_mismatch' });
  }
  const shaPath = `${archivePath}.sha256`;
  fs.writeFileSync(shaPath, `${sha256}  ${path.basename(archivePath)}\n`, { mode: 0o600 });
  const stamp = now();
  const meta = {
    schema: UPLOAD_SCHEMA,
    id,
    original_name: original,
    archive_path: archivePath,
    sha_path: shaPath,
    origin,
    size,
    sha256,
    status: 'uploaded',
    identity: null,
    preflight: null,
    job_id: null,
    created_at: stamp,
    updated_at: stamp,
  };
  writeJson(uploadMetaPath(id), meta);
  return publicUpload(meta);
}

export async function storePackageUpload(req, filename) {
  return storePackageStream(req, filename, {
    declaredSize: req.headers['content-length'],
    onTooLarge: () => req.destroy(),
  });
}

export async function storePackageRemoteDownload(response, filename, options = {}) {
  if (!response?.ok) {
    throw Object.assign(new Error('remote package archive request failed'), { code: 'download_failed' });
  }
  return storePackageStream(response.body, filename, {
    declaredSize: response.headers.get('content-length'),
    expectedSize: options.expectedSize,
    expectedSha256: options.expectedSha256,
    origin: options.origin ?? null,
  });
}

export function getPackageUpload(id, { internal = false } = {}) {
  const value = readJson(uploadMetaPath(packageId(id, 'upload_id')));
  return internal ? value : publicUpload(value);
}

export function updatePackageUpload(id, patch) {
  const current = getPackageUpload(id, { internal: true });
  if (!current) throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
  const next = { ...current, ...patch, updated_at: now() };
  writeJson(uploadMetaPath(id), next);
  return publicUpload(next);
}

export function listPackageUploads() {
  const d = ensure();
  return fs.readdirSync(d.uploads)
    .filter((name) => name.endsWith('.json'))
    .map((name) => publicUpload(readJson(path.join(d.uploads, name))))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function discardPackageUpload(id) {
  const upload = getPackageUpload(id, { internal: true });
  if (!upload) return false;
  const busy = listPackageJobs().some((j) => ACTIVE_JOB_STATUSES.has(j.status) && j.target?.upload_id === id);
  if (busy) throw Object.assign(new Error('upload_job_active'), { code: 'upload_job_active' });
  fs.rmSync(upload.archive_path, { force: true });
  fs.rmSync(upload.sha_path, { force: true });
  fs.rmSync(uploadMetaPath(id), { force: true });
  return true;
}

export function getPackageJob(id) {
  return jobStore().get(id);
}

export function writePackageJob(id, patch) {
  return jobStore().write(id, patch);
}

export function listPackageJobs(limit = 50) {
  ensure();
  return jobStore().list(limit);
}

export function recoverPackageJobs() {
  const d = ensure();
  for (const job of listPackageJobs(500)) {
    if (ACTIVE_JOB_STATUSES.has(job.status) && job.worker_pid && !processAlive(job.worker_pid)) {
      writeJson(jobStore().jobPath(job.id), {
        ...job,
        status: 'failed',
        stage: 'interrupted',
        error: 'package job worker stopped before recording a result',
        updated_at: now(),
        finished_at: now(),
      });
    }
  }
  const lock = readJson(path.join(d.lock, 'owner.json'));
  if (fs.existsSync(d.lock) && (!lock || !processAlive(lock.pid))) fs.rmSync(d.lock, { recursive: true, force: true });
}

export function startPackageJob(action, target) {
  if (!ACTIONS.has(action)) throw Object.assign(new Error('invalid_package_action'), { code: 'invalid_package_action' });
  recoverPackageJobs();
  const active = listPackageJobs().find((j) => ACTIVE_JOB_STATUSES.has(j.status));
  if (active) throw Object.assign(new Error(`package job ${active.id} is ${active.status}`), {
    code: 'package_job_active', job: active,
  });

  /**
   * ⭐ 一次安裝可以是**一串**歸檔：依賴先裝，目標最後。
   *
   * 一個作業帶多個上傳，而不是排隊多個作業——作業引擎本來就一次只跑一個（有鎖），
   * 排隊會讓「這一筆安裝」變成幾筆各自可能中斷的操作，而中斷點恰好是最難查的地方。
   * 一個作業＝一把鎖＝一條恢復路徑。
   */
  const uploadIds = action === 'install' && Array.isArray(target.upload_ids)
    ? target.upload_ids.map((id) => packageId(id, 'upload_id'))
    : null;
  const normalized = action === 'check' || action === 'install'
    ? (uploadIds
      ? { upload_ids: uploadIds, upload_id: uploadIds.at(-1) }
      : { upload_id: packageId(target.upload_id, 'upload_id') })
    : { package_id: packageId(target.package_id, 'package_id') };
  for (const id of normalized.upload_ids ?? (normalized.upload_id ? [normalized.upload_id] : [])) {
    if (!getPackageUpload(id, { internal: true })) {
      throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
    }
  }

  const id = randomId('job');
  const stamp = now();
  const job = {
    schema: JOB_SCHEMA,
    id,
    action,
    target: normalized,
    status: 'queued',
    stage: 'queued',
    worker_pid: null,
    exit_code: null,
    result: null,
    output: '',
    error: null,
    created_at: stamp,
    updated_at: stamp,
    started_at: null,
    finished_at: null,
  };
  writeJson(jobStore().jobPath(id), job);

  const child = spawn(nodeExecutable(), [
    path.join(config.frameworkRoot, 'scripts/package-job.mjs'),
    '--root', config.root,
    '--framework-root', config.frameworkRoot,
    '--installed-root', config.installedRoot,
    '--job', id,
  ], {
    cwd: config.frameworkRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PACKAGES_INSTALLED_DIR: config.installedRoot },
  });
  child.unref();
  const queued = { ...job, worker_pid: child.pid, updated_at: now() };
  writeJson(jobStore().jobPath(id), queued);
  return queued;
}

export function packageManagerSnapshot(loaderPackages = []) {
  recoverPackageJobs();
  const loader = new Map(loaderPackages.map((p) => [p.id, p]));
  const { entries, errors } = resolveInstalledPackages(config.installedRoot);
  const packages = entries.map(({ id, dir, active }) => {
    const loaded = loader.get(id);
    const manifest = readJson(path.join(dir, 'termux-os.package.json'));
    const services = (manifest?.components?.services ?? []).map((s) => typeof s === 'string' ? s : s.id).filter(Boolean);
    return {
      id,
      name: manifest?.name ?? loaded?.name ?? id,
      admin_title: manifest?.admin?.title ?? null,
      description: manifest?.description ?? null,
      publisher: manifest?.publisher ?? null,
      license: manifest?.license ?? manifest?.release?.license ?? null,
      repository: manifest?.release?.repository ?? null,
      version: active.active_version,
      target: active.active_target ?? 'generic',
      previous_version: active.previous_version ?? null,
      previous_target: active.previous_target ?? null,
      // Dev 按鈕要把已安裝的版本複製成工作區專案，需要知道它的 Installed Root 位置。
      installed_dir: dir,
      archive_sha256: active.archive_sha256 ?? null,
      installed_at: active.installed_at ?? null,
      types: manifest?.types ?? loaded?.types ?? [],
      enabled: isPackageEnabled(id) && manifest?.disabled !== true,
      services,
      ports: getPackagePorts(id),
      loader_status: loaded?.status ?? 'not_loaded',
      runtime: loaded?.runtime ?? null,
      health: loaded?.status === 'loaded' ? 'available' : 'attention',
      webui: loaded?.status === 'loaded' ? `/packages/${id}/` : null,
    };
  });
  return {
    schema: SNAPSHOT_SCHEMA,
    packages,
    broken: errors,
    uploads: listPackageUploads(),
    jobs: listPackageJobs(),
    active_job: listPackageJobs().find((j) => ACTIVE_JOB_STATUSES.has(j.status)) ?? null,
  };
}

export function packageControlInternals() {
  return { ...config, ...dirs(), jobPath: jobStore().jobPath, uploadMetaPath, writeJson, readJson, alive: processAlive, now, JOB_SCHEMA };
}

if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'framework-package-control-'));
  const payload = Buffer.from('remote-package-bytes');
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
  configurePackageControl({
    root: path.join(tmp, 'control'),
    frameworkRoot: tmp,
    installedRoot: path.join(tmp, 'packages'),
    maxUploadBytes: 1024,
  });
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const upload = await storePackageRemoteDownload(
    new Response(payload, { status: 200, headers: { 'Content-Length': String(payload.length) } }),
    'github-example-0.1.0-source.tar.gz',
    { expectedSize: payload.length, expectedSha256: expectedSha, origin: { registry: 'https://registry.example.test' } },
  );
  test('remote archive is stored with exact size and SHA-256', upload.size === payload.length && upload.sha256 === expectedSha);
  test('remote origin is retained as public metadata', upload.origin?.registry === 'https://registry.example.test');
  let mismatch = false;
  try {
    await storePackageRemoteDownload(new Response(payload, { status: 200 }), 'bad.tar.gz', {
      expectedSize: payload.length + 1, expectedSha256: expectedSha,
    });
  } catch (error) { mismatch = error.code === 'download_size_mismatch'; }
  test('remote size mismatch is rejected before candidate metadata is written', mismatch && listPackageUploads().length === 1);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
