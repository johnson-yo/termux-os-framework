/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/framework-update-control.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ACTIVE_JOB_STATUSES, assertId, createDetachedJobStore, now, processAlive, randomId, readJson, tailText, writeJson,
} from './job-store.mjs';
import { nodeExecutable } from './node-runtime.mjs';

const JOB_SCHEMA = 'termux-os.framework-update-web-job.v1';
const UPLOAD_SCHEMA = 'termux-os.framework-update-upload.v1';
const SNAPSHOT_SCHEMA = 'termux-os.framework-update-web.v1';
const ACTIONS = new Set(['preflight', 'update', 'registry_upgrade', 'rollback']);
const ID_RE = /^[\w.-]+$/;

let config = {
  root: '', frameworkRoot: '', controlPath: '', maxUploadBytes: 1024 * 1024 * 1024,
};

const dirs = () => ({
  uploads: path.join(config.root, 'webui-uploads'),
  jobs: path.join(config.root, 'webui-jobs'),
  state: path.join(config.root, 'state.v1.json'),
  preflight: path.join(config.root, 'preflight.v1.json'),
  history: path.join(config.root, 'history.v1.jsonl'),
  engineLock: path.join(config.root, 'update.lock'),
  lastGood: path.resolve(config.root, '..', 'backups', 'last-good.json'),
});

const ensure = () => {
  const d = dirs();
  fs.mkdirSync(d.uploads, { recursive: true });
  fs.mkdirSync(d.jobs, { recursive: true });
  return d;
};
const frameworkId = (value, label = 'id') => assertId(value, label, ID_RE);
const uploadPath = (id) => path.join(dirs().uploads, `${frameworkId(id, 'upload_id')}.json`);
const jobStore = () => createDetachedJobStore({ dir: dirs().jobs, idPattern: ID_RE });

const publicUpload = (upload) => upload && ({
  schema: upload.schema, id: upload.id, original_name: upload.original_name, size: upload.size,
  sha256: upload.sha256, status: upload.status, preflight: upload.preflight ?? null,
  origin: upload.origin ?? null, version: upload.version ?? null,
  job_id: upload.job_id ?? null, created_at: upload.created_at, updated_at: upload.updated_at,
});
const publicJob = (job) => job && ({
  schema: job.schema, id: job.id, action: job.action, target: job.target, status: job.status,
  stage: job.stage, worker_pid: job.worker_pid ?? null, exit_code: job.exit_code ?? null,
  engine_state: job.engine_state ?? null, output: job.output ?? '', error: job.error ?? null,
  created_at: job.created_at, updated_at: job.updated_at, started_at: job.started_at ?? null,
  finished_at: job.finished_at ?? null,
});

export function configureFrameworkUpdateControl(opts) {
  config = {
    root: path.resolve(opts.root),
    frameworkRoot: path.resolve(opts.frameworkRoot),
    controlPath: path.resolve(opts.controlPath),
    maxUploadBytes: Number(opts.maxUploadBytes) > 0 ? Number(opts.maxUploadBytes) : 1024 * 1024 * 1024,
  };
  ensure();
  recoverFrameworkUpdateJobs();
}

export function getFrameworkUpdateUpload(id, { internal = false } = {}) {
  const value = readJson(uploadPath(id));
  return internal ? value : publicUpload(value);
}

export function updateFrameworkUpdateUpload(id, patch) {
  const current = getFrameworkUpdateUpload(id, { internal: true });
  if (!current) throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
  const next = { ...current, ...patch, updated_at: now() };
  writeJson(uploadPath(id), next);
  return publicUpload(next);
}

/** 保留几个已结束的候选就够了：更早的既装不上，也不该继续占着设备的存储。 */
const RESOLVED_UPLOADS_KEPT = 3;
/** 超过这个时间还没走完检查的候选，不再当作「正在进行」。 */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Prune candidates that can no longer lead to an install.
 *
 * A failed or applied candidate is a finished story: the reason is in the update history and the
 * archive is dead weight. Keeping every one of them filled the update page with months-old files
 * the user could neither install nor understand, and quietly grew on a phone's storage. The newest
 * few are kept so a just-finished result is still inspectable.
 */
function pruneResolvedUploads(uploads) {
  const pending = uploads.filter((upload) => ['uploaded', 'preflight_passed'].includes(upload.status));
  const resolved = uploads.filter((upload) => !['uploaded', 'preflight_passed'].includes(upload.status));
  // 未处理的候选也只留最新一个，而且它得真的「正在进行」：上传是一次一个的动作，
  // 一天前上传却从没检查过的文件既装不上，也不是待办事项，留着只会让人以为还有事要办。
  const stale = (upload) => Date.now() - Date.parse(upload.created_at ?? 0) > PENDING_MAX_AGE_MS;
  const keep = pending.filter((upload) => !stale(upload)).slice(0, 1);
  const drop = pending.filter((upload) => !keep.includes(upload));
  for (const upload of [...drop, ...resolved.slice(RESOLVED_UPLOADS_KEPT)]) {
    try { discardFrameworkUpdateUpload(upload.id); } catch { /* 正在被作业占用就下次再说 */ }
  }
}

export function listFrameworkUpdateUploads({ prune = false } = {}) {
  const d = ensure();
  const uploads = fs.readdirSync(d.uploads).filter((name) => name.endsWith('.json'))
    .map((name) => publicUpload(readJson(path.join(d.uploads, name)))).filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (prune) {
    pruneResolvedUploads(uploads);
    return uploads.filter((upload) => fs.existsSync(uploadPath(upload.id)));
  }
  return uploads;
}

async function storeFrameworkUpdateStream(stream, filename, {
  declaredSize = null, expectedSize = null, expectedSha256 = null, origin = null, version = null, onTooLarge = null,
} = {}) {
  ensure();
  let decoded;
  try { decoded = decodeURIComponent(String(filename ?? '')); } catch { decoded = String(filename ?? ''); }
  const original = path.basename(decoded).replace(/[\x00-\x1f\x7f]/g, '');
  if (!original.endsWith('.tar.gz')) {
    throw Object.assign(new Error('framework archive must end in .tar.gz'), { code: 'invalid_archive_name' });
  }
  const declared = Number(declaredSize);
  if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
    throw Object.assign(new Error(`upload exceeds ${config.maxUploadBytes} bytes`), { code: 'upload_too_large' });
  }
  const expected = expectedSize == null ? null : Number(expectedSize);
  const expectedHash = expectedSha256 == null ? null : String(expectedSha256).toLowerCase();
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) {
    throw Object.assign(new Error('remote archive size metadata is invalid'), { code: 'download_metadata_invalid' });
  }
  if (expected !== null && expected > config.maxUploadBytes) {
    throw Object.assign(new Error(`download exceeds ${config.maxUploadBytes} bytes`), { code: 'upload_too_large' });
  }
  if (expectedHash !== null && !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw Object.assign(new Error('remote archive SHA-256 metadata is invalid'), { code: 'download_metadata_invalid' });
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw Object.assign(new Error('archive response body is unavailable'), { code: 'download_body_missing' });
  }
  const id = randomId('framework-upload');
  const archivePath = path.join(dirs().uploads, `${id}.tar.gz`);
  const partial = `${archivePath}.partial`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  let fd = null;
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
    if (expected !== null && size !== expected) {
      throw Object.assign(new Error(`download size mismatch: expected ${expected}, got ${size}`), { code: 'download_size_mismatch' });
    }
    fs.renameSync(partial, archivePath);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(partial, { force: true });
    fs.rmSync(archivePath, { force: true });
    throw error;
  }
  const sha256 = hash.digest('hex');
  if (expectedHash !== null && sha256 !== expectedHash) {
    fs.rmSync(archivePath, { force: true });
    throw Object.assign(new Error(`download checksum mismatch: expected ${expectedHash}, got ${sha256}`), { code: 'download_checksum_mismatch' });
  }
  const shaPath = `${archivePath}.sha256`;
  fs.writeFileSync(shaPath, `${sha256}  ${path.basename(archivePath)}\n`, { mode: 0o600 });
  const stamp = now();
  const upload = {
    schema: UPLOAD_SCHEMA, id, original_name: original, archive_path: archivePath, sha_path: shaPath,
    origin, version, size, sha256, status: 'uploaded', preflight: null, job_id: null, created_at: stamp, updated_at: stamp,
  };
  writeJson(uploadPath(id), upload);
  return publicUpload(upload);
}

export async function storeFrameworkUpdateUpload(req, filename) {
  return storeFrameworkUpdateStream(req, filename, {
    declaredSize: req.headers['content-length'],
    onTooLarge: () => req.destroy(),
  });
}

export async function storeFrameworkRemoteDownload(response, filename, options = {}) {
  if (!response?.ok) throw Object.assign(new Error('remote Framework archive request failed'), { code: 'download_failed' });
  return storeFrameworkUpdateStream(response.body, filename, {
    declaredSize: response.headers.get('content-length'),
    expectedSize: options.expectedSize,
    expectedSha256: options.expectedSha256,
    origin: options.origin ?? null,
    version: options.version ?? null,
  });
}

export function discardFrameworkUpdateUpload(id) {
  const upload = getFrameworkUpdateUpload(id, { internal: true });
  if (!upload) return false;
  const busy = listFrameworkUpdateJobs().some((job) => ACTIVE_JOB_STATUSES.has(job.status) && job.target?.upload_id === id);
  if (busy) throw Object.assign(new Error('framework_update_job_active'), { code: 'framework_update_job_active' });
  fs.rmSync(upload.archive_path, { force: true });
  fs.rmSync(upload.sha_path, { force: true });
  fs.rmSync(uploadPath(id), { force: true });
  return true;
}

export function getFrameworkUpdateJob(id, { internal = false } = {}) {
  const value = jobStore().get(id);
  return internal ? value : publicJob(value);
}

export function writeFrameworkUpdateJob(id, patch) {
  return jobStore().write(id, patch);
}

export function listFrameworkUpdateJobs(limit = 50) {
  ensure();
  return jobStore().list(limit).map(publicJob).filter(Boolean);
}

const terminalEngineResult = (state) => state?.status === 'success'
  ? { status: 'success', stage: 'complete', error: null }
  : { status: 'failed', stage: state?.stage === 'rollback' ? 'rolled_back' : 'failed',
    error: state?.message ?? 'framework update worker stopped before recording a result' };

export function recoverFrameworkUpdateJobs() {
  const state = readJson(dirs().state);
  for (const job of listFrameworkUpdateJobs(500)) {
    if (!ACTIVE_JOB_STATUSES.has(job.status) || processAlive(job.worker_pid)) continue;
    const terminal = job.action !== 'preflight' && ['success', 'failed', 'failed_rolled_back'].includes(state?.status)
      ? terminalEngineResult(state)
      : { status: 'failed', stage: 'interrupted', error: 'framework update worker stopped before recording a result' };
    writeJson(jobStore().jobPath(job.id), {
      ...job, ...terminal, worker_pid: job.worker_pid ?? null, engine_state: state,
      finished_at: now(), updated_at: now(),
    });
  }
}

const engineActive = () => fs.existsSync(dirs().engineLock);

export function startFrameworkUpdateJob(action, target = {}) {
  if (!ACTIONS.has(action)) throw Object.assign(new Error('invalid_framework_update_action'), { code: 'invalid_action' });
  recoverFrameworkUpdateJobs();
  const active = listFrameworkUpdateJobs().find((job) => ACTIVE_JOB_STATUSES.has(job.status));
  if (active) throw Object.assign(new Error(`framework update job ${active.id} is ${active.status}`), {
    code: 'framework_update_job_active', job: active,
  });
  if (engineActive()) throw Object.assign(new Error('framework update engine is already active'), { code: 'framework_update_active' });
  const normalized = action === 'rollback' ? {} : {
    upload_id: frameworkId(target.upload_id, 'upload_id'),
    ...(action === 'registry_upgrade' ? { version: frameworkId(target.version, 'version') } : {}),
  };
  const upload = normalized.upload_id ? getFrameworkUpdateUpload(normalized.upload_id, { internal: true }) : null;
  if (normalized.upload_id && !upload) throw Object.assign(new Error('unknown_upload'), { code: 'unknown_upload' });
  if (action === 'update' && upload.status !== 'preflight_passed') {
    throw Object.assign(new Error('successful preflight required before update'), { code: 'preflight_required' });
  }
  if (action === 'registry_upgrade' && (!upload || upload.version !== normalized.version)) {
    throw Object.assign(new Error('Registry Framework upload/version mismatch'), { code: 'confirmation_mismatch' });
  }
  const id = randomId('framework-job');
  const stamp = now();
  const job = {
    schema: JOB_SCHEMA, id, action, target: normalized, status: 'queued', stage: 'queued', worker_pid: null,
    exit_code: null, engine_state: null, output: '', error: null, created_at: stamp, updated_at: stamp,
    started_at: null, finished_at: null,
  };
  writeJson(jobStore().jobPath(id), job);
  const child = spawn(nodeExecutable(), [
    path.join(config.frameworkRoot, 'scripts/framework-update-job.mjs'), '--root', config.root,
    '--framework-root', config.frameworkRoot, '--controller', config.controlPath, '--job', id,
  ], { cwd: config.frameworkRoot, detached: true, stdio: 'ignore', env: { ...process.env } });
  child.unref();
  const queued = { ...job, worker_pid: child.pid, updated_at: now() };
  writeJson(jobStore().jobPath(id), queued);
  return publicJob(queued);
}

const readHistory = (file, limit = 30) => {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).slice(-limit).reverse();
  } catch { return []; }
};

export function frameworkUpdateSnapshot({ currentBuild, registry = null } = {}) {
  recoverFrameworkUpdateJobs();
  const d = dirs();
  const jobs = listFrameworkUpdateJobs();
  const lastGood = readJson(d.lastGood);
  return {
    ok: true, schema: SNAPSHOT_SCHEMA, current_build: currentBuild ?? null,
    registry,
    engine_state: readJson(d.state), preflight_result: readJson(d.preflight), last_good: lastGood ? {
      build: lastGood.deploy_id ?? null, created_at: lastGood.created_at ?? null, health: lastGood.health ?? null,
    } : null,
    engine_locked: engineActive(), history: readHistory(d.history), uploads: listFrameworkUpdateUploads({ prune: true }), jobs,
    active_job: jobs.find((job) => ACTIVE_JOB_STATUSES.has(job.status)) ?? null,
  };
}

export function frameworkUpdateControlInternals() {
  return { ...config, ...dirs(), readJson, writeJson, now, tail: tailText, jobPath: jobStore().jobPath, uploadPath };
}
