/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: scripts/framework-update-job.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureFrameworkUpdateControl, frameworkUpdateControlInternals, getFrameworkUpdateJob,
  getFrameworkUpdateUpload, updateFrameworkUpdateUpload, writeFrameworkUpdateJob,
} from '../src/system/framework-update-control.mjs';

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const root = value('--root');
const frameworkRoot = value('--framework-root');
const controller = value('--controller');
const jobId = value('--job');
if (!root || !frameworkRoot || !controller || !jobId) {
  console.error('usage: framework-update-job.mjs --root <updates-root> --framework-root <root> --controller <framework.sh> --job <id>');
  process.exit(2);
}

configureFrameworkUpdateControl({ root, frameworkRoot, controlPath: controller });
const io = frameworkUpdateControlInternals();
const previousBuild = (() => {
  try { return fs.readFileSync(path.join(frameworkRoot, '.deploy-id'), 'utf8').trim() || null; }
  catch { return null; }
})();
const installerTempRoot = path.join(os.homedir(), '.termux-os', 'tmp', 'termux-os-framework-installer');
const workerEnv = {
  ...process.env,
  // A Framework server launched without Termux's interactive shell may have no
  // writable TMPDIR. Keep the detached installer inside private app storage.
  TMPDIR: process.env.TMPDIR || path.dirname(installerTempRoot),
  FRAMEWORK_WORK_ROOT: process.env.FRAMEWORK_WORK_ROOT || installerTempRoot,
};
let job = getFrameworkUpdateJob(jobId, { internal: true });
if (!job) process.exit(2);
for (let attempt = 0; attempt < 100 && job.worker_pid !== process.pid; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  job = getFrameworkUpdateJob(jobId, { internal: true });
}

let upload = null;
try {
  job = writeFrameworkUpdateJob(jobId, {
    worker_pid: process.pid, status: 'running', stage: job.action === 'preflight' ? 'preflight' : 'starting',
    started_at: io.now(),
  });
  if (job.target.upload_id) {
    upload = getFrameworkUpdateUpload(job.target.upload_id, { internal: true });
    if (!upload) throw new Error('unknown_upload');
  }
  const command = job.action === 'rollback'
    ? [controller, 'rollback']
    : job.action === 'registry_upgrade'
      ? [path.join(frameworkRoot, 'scripts/upgrade.sh'), '--archive', upload.archive_path,
        '--sha256', upload.sha256, '--version', job.target.version]
      : [controller, job.action === 'preflight' ? 'preflight-update' : 'update', upload.archive_path, upload.sha_path];
  const child = job.action === 'registry_upgrade'
    ? spawn('bash', command, { cwd: frameworkRoot, stdio: ['ignore', 'pipe', 'pipe'], env: workerEnv })
    : spawn('bash', command, { cwd: frameworkRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const persistOutput = () => writeFrameworkUpdateJob(jobId, { output: io.tail(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim()) });
  child.stdout.on('data', (chunk) => { stdout = io.tail(stdout + chunk); persistOutput(); });
  child.stderr.on('data', (chunk) => { stderr = io.tail(stderr + chunk); persistOutput(); });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const output = io.tail(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim());
  let engineState = io.readJson(io.state);
  if (job.action === 'registry_upgrade' && exitCode === 0) {
    engineState = {
      schema: 'termux-os.framework-update-state.v1', update_id: job.id,
      previous_build: previousBuild, candidate_build: `framework-${job.target.version}`,
      stage: 'complete', status: 'success',
      message: 'Framework update completed by Registry installer', registry_upgrade: true,
      started_at: job.started_at ?? io.now(), updated_at: io.now(),
    };
    io.writeJson(io.state, engineState);
  }
  const preflight = job.action === 'preflight' ? io.readJson(io.preflight) : null;
  const engineResult = preflight ?? engineState;
  const success = exitCode === 0 && (job.action === 'preflight'
    ? preflight?.status === 'success'
    : job.action === 'registry_upgrade' ? true : engineState?.status === 'success');
  const failure = stderr.trim() || stdout.trim() || engineResult?.message || `exit ${exitCode}`;
  if (upload && job.action === 'preflight') {
    updateFrameworkUpdateUpload(upload.id, {
      status: success ? 'preflight_passed' : 'preflight_failed', job_id: jobId,
      preflight: { ok: success, candidate_build: preflight?.candidate_build ?? null, result: preflight, output, checked_at: io.now() },
    });
  }
  if (upload && ['update', 'registry_upgrade'].includes(job.action) && success) {
    updateFrameworkUpdateUpload(upload.id, { status: 'applied', job_id: jobId });
  }
  writeFrameworkUpdateJob(jobId, {
    status: success ? 'success' : 'failed', stage: success ? 'complete' : (engineState?.stage ?? 'failed'),
    exit_code: exitCode, engine_state: engineResult, output,
    error: success ? null : io.tail(failure, 4096),
    finished_at: io.now(),
  });
  process.exitCode = success ? 0 : 1;
} catch (error) {
  writeFrameworkUpdateJob(jobId, {
    status: 'failed', stage: 'failed', error: String(error?.message ?? error), finished_at: io.now(),
  });
  process.exitCode = 1;
}
