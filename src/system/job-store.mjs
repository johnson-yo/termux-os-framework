/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/job-store.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
export const now = () => new Date().toISOString();
export const randomId = (prefix) => `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
export const tailText = (value, max = 64 * 1024) => String(value ?? '').length > max ? String(value).slice(-max) : String(value ?? '');
export const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
export const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
};

export function assertId(value, label = 'id', pattern = /^[\w.-]+$/) {
  const id = String(value ?? '');
  if (!pattern.test(id)) throw Object.assign(new Error(`invalid_${label}`), { code: `invalid_${label}` });
  return id;
}

export function createDetachedJobStore({ dir, idPattern = /^[\w.-]+$/ } = {}) {
  const root = path.resolve(dir ?? '.');
  const jobPath = (id) => path.join(root, `${assertId(id, 'job_id', idPattern)}.json`);
  const ensure = () => fs.mkdirSync(root, { recursive: true });
  const get = (id) => readJson(jobPath(id));
  const write = (id, patch) => {
    const current = get(id);
    if (!current) throw Object.assign(new Error('unknown_job'), { code: 'unknown_job' });
    const next = { ...current, ...patch, updated_at: now() };
    writeJson(jobPath(id), next);
    return next;
  };
  const list = (limit = 50) => {
    ensure();
    return fs.readdirSync(root).filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(root, name))).filter(Boolean)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
  };
  return { root, ensure, jobPath, get, write, list };
}
