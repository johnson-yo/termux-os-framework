/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An explicit HTTP(S) URL, temporary request headers, and expected file metadata.
 * [OUTPUT]: A verified file stream landed at a caller-owned staging path with resume/parallel facts.
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
export const TRANSFER_DEFAULT_PARALLELISM = 4;
export const TRANSFER_MAX_PARALLELISM = 8;
export const TRANSFER_PARALLEL_THRESHOLD_BYTES = 16 * 1024 * 1024;

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

const responseHeader = (response, name) => {
  if (typeof response?.headers?.get === 'function') return response.headers.get(name);
  const headers = response?.headers ?? {};
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null;
};

const contentRangeOf = (response) => {
  const value = String(responseHeader(response, 'content-range') ?? '').trim();
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (![start, end].every(Number.isSafeInteger) || (total !== null && !Number.isSafeInteger(total))) return null;
  return { start, end, total };
};

const assertRangeResponse = (response, { start, end, size }) => {
  if (response?.status === 200) {
    throw errorWithCode('transfer_range_unsupported', 'transfer source ignored a Range request');
  }
  if (!response?.ok || response.status !== 206) {
    throw errorWithCode('transfer_http_error', `ranged transfer returned HTTP ${response?.status ?? 'unknown'}`, { status: response?.status });
  }
  const range = contentRangeOf(response);
  if (!range || range.start !== start || range.end !== end || range.total !== size) {
    throw errorWithCode('transfer_range_invalid', `ranged transfer returned an invalid Content-Range for ${start}-${end}/${size}`);
  }
};

const cancelBody = async (response) => {
  try { await response?.body?.cancel?.(); } catch { /* preserve the transfer result */ }
};

const probeRangeSupport = async (fetchImpl, url, {
  headers,
  headTimeoutMs,
  signal,
  size,
} = {}) => {
  const opened = await openStream(fetchImpl, url, {
    headers: { ...headers, Range: 'bytes=0-0' },
    headTimeoutMs,
    signal,
  });
  try {
    if (opened.response.status === 200) {
      await cancelBody(opened.response);
      return false;
    }
    assertRangeResponse(opened.response, { start: 0, end: 0, size });
    await cancelBody(opened.response);
    return true;
  } finally { opened.release(); }
};

const parallelRanges = (size, parallelism) => {
  const width = Math.min(size, parallelism);
  const base = Math.floor(size / width);
  const extra = size % width;
  const ranges = [];
  let start = 0;
  for (let index = 0; index < width; index += 1) {
    const length = base + (index < extra ? 1 : 0);
    ranges.push({ start, end: start + length - 1 });
    start += length;
  }
  return ranges;
};

const downloadRange = async (file, url, fd, range, {
  fetchImpl,
  headers,
  headTimeoutMs,
  stallTimeoutMs,
  signal,
  onProgress,
  attempt,
  size,
  progressState,
} = {}) => {
  const opened = await openStream(fetchImpl, url, {
    headers: { ...headers, Range: `bytes=${range.start}-${range.end}` },
    headTimeoutMs,
    signal,
  });
  let stallTimer = null;
  let responseError = null;
  try {
    assertRangeResponse(opened.response, { ...range, size });
    const expected = range.end - range.start + 1;
    let received = 0;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => opened.controller.abort(new Error(`no data for ${stallTimeoutMs}ms`)), stallTimeoutMs);
    };
    armStall();
    for await (const chunk of opened.response.body ?? []) {
      signal?.throwIfAborted?.();
      const buffer = Buffer.from(chunk);
      if (received + buffer.length > expected) {
        throw errorWithCode('transfer_range_size_mismatch', `ranged transfer exceeded ${expected} bytes for ${file.path}`);
      }
      fs.writeSync(fd, buffer, 0, buffer.length, range.start + received);
      received += buffer.length;
      progressState.bytes += buffer.length;
      armStall();
      onProgress({
        path: file.path,
        stage: 'progress',
        mode: 'parallel_range',
        range_start: range.start,
        range_end: range.end,
        bytes: progressState.bytes,
        total: size,
        resumed: false,
        resume_from_bytes: 0,
        attempt,
      });
    }
    if (received !== expected) {
      throw errorWithCode('transfer_range_size_mismatch', `ranged transfer wrote ${received} of ${expected} bytes for ${file.path}`);
    }
  } catch (error) {
    responseError = error;
    await cancelBody(opened.response);
    throw error;
  } finally {
    clearTimeout(stallTimer);
    opened.release();
    if (responseError) signal?.throwIfAborted?.();
  }
};

const downloadParallel = async (file, partialPath, {
  fetchImpl,
  headers,
  headTimeoutMs,
  stallTimeoutMs,
  signal,
  onProgress,
  attempt,
  size,
  parallelism,
} = {}) => {
  signal?.throwIfAborted?.();
  if (!await probeRangeSupport(fetchImpl, file.url, { headers, headTimeoutMs, signal, size })) return false;

  const fd = fs.openSync(partialPath, 'w', 0o600);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.('abort', forwardAbort, { once: true });
  const progressState = { bytes: 0 };
  let complete = false;
  try {
    fs.ftruncateSync(fd, size);
    const jobs = parallelRanges(size, parallelism).map((range) => downloadRange(file, file.url, fd, range, {
      fetchImpl,
      headers,
      headTimeoutMs,
      stallTimeoutMs,
      signal: controller.signal,
      onProgress,
      attempt,
      size,
      progressState,
    }).catch((error) => {
      controller.abort(error);
      throw error;
    }));
    const settled = await Promise.allSettled(jobs);
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    fs.fsyncSync(fd);
    complete = true;
    return true;
  } catch (error) {
    if (error?.code === 'transfer_range_unsupported') return false;
    throw error;
  } finally {
    signal?.removeEventListener?.('abort', forwardAbort);
    fs.closeSync(fd);
    if (!complete) fs.rmSync(partialPath, { force: true });
  }
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
  parallelism = TRANSFER_DEFAULT_PARALLELISM,
  parallelThresholdBytes = TRANSFER_PARALLEL_THRESHOLD_BYTES,
} = {}) {
  const url = validateTransferUrl(file?.url);
  const size = Number(file?.size);
  const expectedHash = String(file?.sha256 ?? '').toLowerCase();
  if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw errorWithCode('transfer_file_metadata_invalid', `invalid expected metadata for ${file?.path ?? 'file'}`);
  }
  const finalPath = path.resolve(destination);
  const partialPath = `${finalPath}.part`;
  const requestedParallelism = Number.isSafeInteger(Number(parallelism))
    ? Math.min(TRANSFER_MAX_PARALLELISM, Math.max(1, Number(parallelism)))
    : TRANSFER_DEFAULT_PARALLELISM;
  const requestedParallelThreshold = Number.isSafeInteger(Number(parallelThresholdBytes))
    ? Math.max(0, Number(parallelThresholdBytes))
    : TRANSFER_PARALLEL_THRESHOLD_BYTES;
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
    let appended = false;
    try {
      let written = resume ? have : 0;
      let digest = null;
      let usedParallel = false;
      if (!resume && size > 0 && size >= requestedParallelThreshold && requestedParallelism > 1) {
        usedParallel = await downloadParallel(file, partialPath, {
          fetchImpl,
          headers,
          headTimeoutMs,
          stallTimeoutMs,
          signal,
          onProgress,
          attempt: attempt + 1,
          size,
          parallelism: requestedParallelism,
        });
        if (usedParallel) {
          written = size;
          digest = hashPrefix(partialPath, size).digest('hex');
        }
      }
      if (!usedParallel) {
        opened = await openStream(fetchImpl, url, { headers: requestHeaders, headTimeoutMs, signal });
        const { response } = opened;
        if (!response.ok || !response.body && size > 0) {
          throw errorWithCode('transfer_http_error', `transfer ${file.path} returned HTTP ${response.status}`, { status: response.status });
        }
        const append = resume && response.status === 206;
        appended = append;
        const hash = append ? hashPrefix(partialPath, have) : crypto.createHash('sha256');
        written = append ? have : 0;
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
        digest = hash.digest('hex');
      }
      if (written === size && digest === expectedHash) {
        fs.renameSync(partialPath, finalPath);
        opened?.release?.();
        onProgress({ path: file.path, stage: 'done', bytes: written, total: size, resumed: appended, resume_from_bytes: appended ? have : 0, parallel: usedParallel });
        return { path: file.path, destination: finalPath, bytes: written, reused: false, attempts: attempt + 1, resumed: appended, resume_from_bytes: appended ? have : 0, parallel: usedParallel };
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
  const ranged = [];
  const parallel = await fetchTransferFile({ path: 'parallel.bin', url: 'https://example.invalid/parallel.bin', size: body.length, sha256 }, path.join(root, 'parallel.bin'), {
    maxAttempts: 1,
    parallelism: 2,
    parallelThresholdBytes: 1,
    fetchImpl: async (_url, options) => {
      const requested = String(options.headers.Range ?? '');
      const match = /^bytes=(\d+)-(\d+)$/.exec(requested);
      const start = Number(match?.[1] ?? 0);
      const end = Number(match?.[2] ?? 0);
      ranged.push(requested);
      return {
        ok: true,
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${body.length}` },
        body: (async function* stream() { yield body.subarray(start, end + 1); }()),
      };
    },
  });
  test('bounded parallel ranges assemble a verified file', parallel.parallel === true && ranged.length === 3 && fs.readFileSync(path.join(root, 'parallel.bin')).equals(body));
  let fallbackCalls = 0;
  const fallback = await fetchTransferFile({ path: 'fallback.bin', url: 'https://example.invalid/fallback.bin', size: body.length, sha256 }, path.join(root, 'fallback.bin'), {
    maxAttempts: 1,
    parallelism: 2,
    parallelThresholdBytes: 1,
    fetchImpl: async () => {
      fallbackCalls += 1;
      return { ok: true, status: 200, body: (async function* stream() { yield body; }()) };
    },
  });
  test('Range-unaware sources fall back to one verified stream', fallback.parallel === false && fallbackCalls === 2 && fs.readFileSync(path.join(root, 'fallback.bin')).equals(body));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
