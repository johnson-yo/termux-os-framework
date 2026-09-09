/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An explicit HTTP(S) URL, temporary request headers, and expected file metadata.
 * [OUTPUT]: A verified file stream landed at a caller-owned staging path with resume facts.
 * [POS]: src/assets/transfer/http.mjs in termux-os-framework.
 * [PROTOCOL]: This module has no source-brand or catalog policy; callers resolve URLs before entry.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRANSFER_HEAD_TIMEOUT_MS = 6_000;
export const TRANSFER_STALL_TIMEOUT_MS = 45_000;
export const TRANSFER_MAX_ATTEMPTS = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const errorWithCode = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export function validateTransferUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw errorWithCode('transfer_url_invalid', 'transfer URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw errorWithCode('transfer_url_invalid', `transfer URL protocol is not allowed: ${url.protocol}`);
  }
  return url.href;
}

const openStream = async (fetchImpl, url, { headers = {}, headTimeoutMs, signal } = {}) => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`no response within ${headTimeoutMs}ms`)), headTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'follow', signal: controller.signal });
    return {
      response,
      controller,
      release: () => signal?.removeEventListener?.('abort', forwardAbort),
    };
  } catch (error) {
    signal?.removeEventListener?.('abort', forwardAbort);
    throw error;
  } finally { clearTimeout(timer); }
};

const hashPrefix = (filePath, bytes) => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < bytes) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
      if (count <= 0) throw new Error('partial file ended before its recorded length');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
  } finally { fs.closeSync(fd); }
  return hash;
};

/**
 * Download one explicitly resolved file. The `.part` path survives a failed
 * call, while only a complete verified body is renamed to the final path.
 */
export async function fetchTransferFile(file, destination, {
  fetchImpl = fetch,
  headers = {},
  signal = undefined,
  onProgress = () => {},
  headTimeoutMs = TRANSFER_HEAD_TIMEOUT_MS,
  stallTimeoutMs = TRANSFER_STALL_TIMEOUT_MS,
  maxAttempts = TRANSFER_MAX_ATTEMPTS,
  sleepImpl = sleep,
} = {}) {
  const url = validateTransferUrl(file?.url);
  const size = Number(file?.size);
  const expectedHash = String(file?.sha256 ?? '').toLowerCase();
  if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw errorWithCode('transfer_file_metadata_invalid', `invalid expected metadata for ${file?.path ?? 'file'}`);
  }
  const finalPath = path.resolve(destination);
  const partialPath = `${finalPath}.part`;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  if (fs.existsSync(finalPath)) {
    const stat = fs.statSync(finalPath);
    if (stat.isFile() && stat.size === size) {
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(finalPath, 'r');
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      } finally { fs.closeSync(fd); }
      if (hash.digest('hex') === expectedHash) {
        onProgress({ path: file.path, stage: 'reused', bytes: size, total: size });
        return { path: file.path, destination: finalPath, bytes: size, reused: true, attempts: 0 };
      }
    }
    fs.rmSync(finalPath, { force: true });
  }

  const attempts = [];
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    signal?.throwIfAborted?.();
    const lastChance = attempt === Math.max(1, maxAttempts) - 1;
    // A single-attempt call still needs the caller's surviving prefix. The
    // clean restart is only the final chance after at least one failed try.
    if (lastChance && attempt > 0) fs.rmSync(partialPath, { force: true });
    let have = 0;
    try { have = fs.statSync(partialPath).size; } catch { /* no prefix */ }
    if (have > size) { fs.rmSync(partialPath, { force: true }); have = 0; }
    const resume = have > 0 && have < size;
    const requestHeaders = resume ? { ...headers, Range: `bytes=${have}-` } : { ...headers };
    onProgress({ path: file.path, stage: attempt ? 'retry' : 'start', bytes: resume ? have : 0, total: size, attempt: attempt + 1, resumed: resume, resume_from_bytes: resume ? have : 0 });
    let opened = null;
    try {
      opened = await openStream(fetchImpl, url, { headers: requestHeaders, headTimeoutMs, signal });
      const { response } = opened;
      if (!response.ok || !response.body && size > 0) {
        throw errorWithCode('transfer_http_error', `transfer ${file.path} returned HTTP ${response.status}`, { status: response.status });
      }
      const append = resume && response.status === 206;
      const hash = append ? hashPrefix(partialPath, have) : crypto.createHash('sha256');
      let written = append ? have : 0;
      const handle = fs.openSync(partialPath, append ? 'a' : 'w', 0o600);
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => opened.controller.abort(new Error(`no data for ${stallTimeoutMs}ms`)), stallTimeoutMs);
      };
      try {
        if (size > 0) {
          armStall();
          for await (const chunk of response.body) {
            signal?.throwIfAborted?.();
            const buffer = Buffer.from(chunk);
            hash.update(buffer);
            fs.writeSync(handle, buffer);
            written += buffer.length;
            armStall();
            onProgress({ path: file.path, stage: 'progress', bytes: written, total: size, resumed: append, resume_from_bytes: append ? have : 0, attempt: attempt + 1 });
          }
        }
        fs.fsyncSync(handle);
      } finally { clearTimeout(stallTimer); fs.closeSync(handle); }
      const digest = hash.digest('hex');
      if (written === size && digest === expectedHash) {
        fs.renameSync(partialPath, finalPath);
        opened.release();
        onProgress({ path: file.path, stage: 'done', bytes: written, total: size, resumed: append, resume_from_bytes: append ? have : 0 });
        return { path: file.path, destination: finalPath, bytes: written, reused: false, attempts: attempt + 1, resumed: append, resume_from_bytes: append ? have : 0 };
      }
      if (written >= size) fs.rmSync(partialPath, { force: true });
      throw errorWithCode(written === size ? 'transfer_checksum_mismatch' : 'transfer_size_mismatch',
        written === size ? `transfer ${file.path} SHA-256 does not match` : `transfer ${file.path} wrote ${written} of ${size} bytes`);
    } catch (error) {
      try { opened?.release?.(); } catch { /* preserve transfer error */ }
      signal?.throwIfAborted?.();
      attempts.push({ attempt: attempt + 1, detail: String(error?.message ?? error) });
      onProgress({ path: file.path, stage: 'attempt_failed', bytes: (() => { try { return fs.statSync(partialPath).size; } catch { return 0; } })(), total: size, attempt: attempt + 1, detail: String(error?.message ?? error) });
      if (attempt + 1 < Math.max(1, maxAttempts)) await sleepImpl(0);
    }
  }
  throw errorWithCode('transfer_failed', `transfer failed for ${file.path}: ${attempts.map((item) => item.detail).join(' | ')}`, { attempts, path: file.path });
}

// ============================================================
// Self-test: node src/assets/transfer/http.mjs --self-test
// ============================================================
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-transfer-http-'));
  const body = Buffer.from('generic transfer bytes');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  let calls = 0;
  const result = await fetchTransferFile({ path: 'model.bin', url: 'https://example.invalid/model.bin', size: body.length, sha256 }, path.join(root, 'model.bin'), {
    maxAttempts: 1,
    fetchImpl: async () => ({ ok: true, status: 200, body: (async function* stream() { calls++; yield body; }()) }),
  });
  test('explicit URL is streamed and verified', result.bytes === body.length && calls === 1 && fs.readFileSync(path.join(root, 'model.bin')).equals(body));
  const partial = path.join(root, 'partial.bin.part');
  fs.writeFileSync(partial, body.subarray(0, 7));
  let range = null;
  const resumed = await fetchTransferFile({ path: 'partial.bin', url: 'https://example.invalid/partial.bin', size: body.length, sha256 }, path.join(root, 'partial.bin'), {
    maxAttempts: 1,
    fetchImpl: async (_url, options) => {
      range = options.headers.Range;
      return { ok: true, status: 206, body: (async function* stream() { yield body.subarray(7); }()) };
    },
  });
  test('206 response resumes a surviving prefix', resumed.resumed === true && range === 'bytes=7-' && fs.readFileSync(path.join(root, 'partial.bin')).equals(body));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
