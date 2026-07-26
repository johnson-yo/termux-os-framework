/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: scripts/package-job.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  configurePackageControl, getPackageJob, getPackageUpload, packageControlInternals,
  updatePackageUpload, writePackageJob,
} from '../src/system/package-control.mjs';
import { nodeExecutable } from '../src/system/node-runtime.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const root = value('--root');
const frameworkRoot = value('--framework-root');
const installedRoot = value('--installed-root');
const jobId = value('--job');
if (!root || !frameworkRoot || !installedRoot || !jobId) {
  console.error('usage: package-job.mjs --root <dir> --framework-root <dir> --installed-root <dir> --job <id>');
  process.exit(2);
}

configurePackageControl({ root, frameworkRoot, installedRoot });
const io = packageControlInternals();
let job = getPackageJob(jobId);
if (!job) process.exit(2);
// 父进程先 spawn 才拿到 pid；等它把 pid 写回 queued job，避免 worker 的 running 状态被迟到的
// queued 写入覆盖。
for (let i = 0; i < 100 && job.worker_pid !== process.pid; i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  job = getPackageJob(jobId);
}

const tail = (text, max = 64 * 1024) => text.length > max ? text.slice(-max) : text;
const stageFor = {
  check: 'preflight',
  install: 'installing',
  rollback: 'rolling_back',
  uninstall: 'uninstalling',
};

let lockHeld = false;
try {
  fs.mkdirSync(io.lock);
  io.writeJson(`${io.lock}/owner.json`, { pid: process.pid, job_id: jobId, at: io.now() });
  lockHeld = true;
} catch {
  writePackageJob(jobId, {
    status: 'failed', stage: 'blocked', error: 'another package lifecycle job owns the lock',
    finished_at: io.now(),
  });
  process.exit(1);
}

try {
  job = writePackageJob(jobId, {
    worker_pid: process.pid,
    status: 'running',
    stage: stageFor[job.action] ?? 'running',
    started_at: io.now(),
  });

  const delay = Number(process.env.PACKAGE_JOB_TEST_DELAY_MS);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

  let cliArgs;
  let upload = null;
  if (job.target.upload_id) {
    upload = getPackageUpload(job.target.upload_id, { internal: true });
    if (!upload) throw new Error('unknown_upload');
    cliArgs = job.action === 'check'
      ? ['check', upload.archive_path]
      : ['install', upload.archive_path, upload.sha_path];
  } else {
    cliArgs = [job.action, job.target.package_id];
  }

  const child = spawn(nodeExecutable(), [io.frameworkRoot + '/scripts/package-manager.mjs', ...cliArgs], {
    cwd: io.frameworkRoot,
    env: { ...process.env, PACKAGES_INSTALLED_DIR: io.installedRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const persistOutput = () => writePackageJob(jobId, {
    output: tail(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim()),
  });
  child.stdout.on('data', (chunk) => { stdout = tail(stdout + chunk); persistOutput(); });
  child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk); persistOutput(); });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));

  let result = null;
  if (job.action === 'check' && stdout.trim()) {
    try { result = JSON.parse(stdout); } catch { /* failure output remains in job */ }
  }
  const success = exitCode === 0;
  if (upload && job.action === 'check') {
    const identity = result?.package ?? null;
    updatePackageUpload(upload.id, {
      status: success && result?.ok ? 'preflight_passed' : 'preflight_failed',
      identity,
      preflight: result,
      job_id: jobId,
    });
  }
  if (upload && job.action === 'install') {
    fs.rmSync(upload.archive_path, { force: true });
    fs.rmSync(upload.sha_path, { force: true });
    updatePackageUpload(upload.id, {
      status: success ? 'installed' : 'install_failed',
      job_id: jobId,
    });
  }

  const final = writePackageJob(jobId, {
    status: success ? 'success' : 'failed',
    stage: success ? 'complete' : 'failed',
    exit_code: exitCode,
    result,
    output: tail(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim()),
    error: success ? null : tail(stderr.trim() || stdout.trim() || `exit ${exitCode}`, 4096),
    finished_at: io.now(),
  });
  fs.appendFileSync(io.history, `${JSON.stringify(final)}\n`);
  process.exitCode = success ? 0 : 1;
} catch (error) {
  const final = writePackageJob(jobId, {
    status: 'failed',
    stage: 'failed',
    error: String(error?.message ?? error),
    finished_at: io.now(),
  });
  fs.appendFileSync(io.history, `${JSON.stringify(final)}\n`);
  process.exitCode = 1;
} finally {
  if (lockHeld) fs.rmSync(io.lock, { recursive: true, force: true });
}
