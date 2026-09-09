/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Explicit transfer file specifications, a staging root, and generic stream options.
 * [OUTPUT]: A safe, verified staged file set ready for content-addressed commit.
 * [POS]: src/assets/transfer/staging.mjs in termux-os-framework.
 * [PROTOCOL]: Staging validates paths and bytes only; it never selects a source or Asset policy.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTransferFile } from './http.mjs';

const errorWithCode = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export function safeRelativePath(value) {
  const relative = String(value ?? '');
  return Boolean(relative && !path.posix.isAbsolute(relative) && !relative.includes('\\')
    && path.posix.normalize(relative) === relative && relative !== '.' && !relative.split('/').includes('..'));
}

export function assertTransferFiles(files) {
  if (!Array.isArray(files) || !files.length) throw errorWithCode('transfer_files_required', 'at least one transfer file is required');
  const seen = new Set();
  return files.map((file) => {
    const relative = String(file?.path ?? '');
    if (!safeRelativePath(relative)) throw errorWithCode('transfer_file_path_invalid', `unsafe transfer file path: ${relative}`);
    if (seen.has(relative)) throw errorWithCode('transfer_file_duplicate', `duplicate transfer file path: ${relative}`);
    seen.add(relative);
    const size = Number(file?.size);
    const sha256 = String(file?.sha256 ?? '').toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw errorWithCode('transfer_file_metadata_invalid', `invalid transfer file metadata: ${relative}`);
    }
    return { ...file, path: relative, size, sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export const stageFilePath = (root, relative) => {
  if (!safeRelativePath(relative)) throw errorWithCode('transfer_file_path_invalid', `unsafe transfer file path: ${relative}`);
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target === base || !target.startsWith(`${base}${path.sep}`)) throw errorWithCode('transfer_file_path_invalid', `file escapes staging root: ${relative}`);
  return target;
};

export const pendingBytes = (files, root) => assertTransferFiles(files).reduce((sum, file) => {
  const target = stageFilePath(root, file.path);
  try {
    const stat = fs.statSync(target);
    if (stat.isFile() && stat.size === file.size) return sum;
    if (stat.isFile() && stat.size < file.size) return sum + file.size - stat.size;
  } catch { /* missing */ }
  return sum + file.size;
}, 0);

export function freeSpace(root) {
  try {
    const existing = (() => {
      let current = path.resolve(root);
      for (;;) {
        if (fs.existsSync(current)) return current;
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    })();
    const stat = fs.statfsSync(existing);
    return { known: true, free_bytes: Number(stat.bavail) * Number(stat.bsize) };
  } catch { return { known: false, free_bytes: null }; }
}

export async function stagePullFiles(files, root, options = {}) {
  const normalized = assertTransferFiles(files);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const landed = [];
  for (const file of normalized) {
    const destination = stageFilePath(root, file.path);
    landed.push(await fetchTransferFile(file, destination, {
      ...options,
      onProgress: (event) => options.onProgress?.({ ...event, file: event.path }),
    }));
  }
  const verified = verifyStagedFiles(normalized, root);
  if (!verified.ok) throw errorWithCode('staged_payload_invalid', verified.detail, verified);
  return { files: normalized, landed, verified };
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

export function verifyStagedFiles(files, root) {
  let bytes = 0;
  try {
    for (const file of assertTransferFiles(files)) {
      const target = stageFilePath(root, file.path);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: 'staged_file_not_regular', path: file.path, detail: `staged file is not a regular file: ${file.path}` };
      if (stat.size !== file.size) return { ok: false, error: 'staged_size_mismatch', path: file.path, detail: `${file.path}: ${stat.size} != ${file.size}` };
      const actual = sha256File(target);
      if (actual !== file.sha256) return { ok: false, error: 'staged_checksum_mismatch', path: file.path, detail: `${file.path}: ${actual} != ${file.sha256}` };
      bytes += stat.size;
    }
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, error: 'staged_file_missing', detail: String(error?.message ?? error) };
  }
}

export function writePushStream(input, root, file, {
  maxBytes = 4 * 1024 * 1024 * 1024, offset = 0, onProgress = () => {},
} = {}) {
  const normalized = assertTransferFiles([file])[0];
  if (!Number.isSafeInteger(Number(offset)) || Number(offset) < 0 || Number(offset) > normalized.size) {
    throw errorWithCode('transfer_offset_invalid', `invalid upload offset for ${normalized.path}`);
  }
  offset = Number(offset);
  const destination = stageFilePath(root, normalized.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.part`;
  if (offset > 0) {
    let existing = 0;
    try { existing = fs.statSync(temporary).size; } catch { /* no prefix */ }
    if (existing !== offset) throw errorWithCode('transfer_offset_mismatch', `${normalized.path}: existing prefix ${existing} != ${offset}`);
  }
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(temporary, { flags: offset ? 'a' : 'w', mode: 0o600 });
    let bytes = offset;
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; output.destroy(); reject(error); };
    input.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes || bytes > normalized.size) {
        fail(errorWithCode('transfer_upload_too_large', `uploaded ${normalized.path} exceeds declared size`));
        input.destroy?.();
        return;
      }
      if (!output.write(chunk)) input.pause();
      onProgress({ file: normalized.path, stage: 'progress', bytes, total: normalized.size, offset });
    });
    output.on('drain', () => input.resume?.());
    output.on('error', fail);
    input.on('aborted', () => fail(errorWithCode('transfer_upload_aborted', 'transfer upload aborted')));
    input.on('error', fail);
    input.on('end', () => {
      if (settled) return;
      output.end(() => {
        if (bytes !== normalized.size) return fail(errorWithCode('transfer_size_mismatch', `${normalized.path}: ${bytes} != ${normalized.size}`));
        try { fs.renameSync(temporary, destination); settled = true; resolve({ path: normalized.path, destination, bytes }); }
        catch (error) { fail(error); }
      });
    });
  });
}

// ============================================================
// Self-test: node src/assets/transfer/staging.mjs --self-test
// ============================================================
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-staging-'));
  const body = Buffer.from('staged');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  test('unsafe relative path is rejected', !safeRelativePath('../escape') && !safeRelativePath('/absolute'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'model.bin'), body);
  test('staged file set verifies size and hash', verifyStagedFiles([{ path: 'model.bin', size: body.length, sha256 }], root).ok);
  fs.writeFileSync(path.join(root, 'model.bin'), 'bad');
  test('tampered staged file is not accepted', !verifyStagedFiles([{ path: 'model.bin', size: body.length, sha256 }], root).ok);
  fs.rmSync(path.join(root, 'model.bin'));
  fs.symlinkSync(path.join(root, 'missing-target.bin'), path.join(root, 'model.bin'));
  test('staged symlink is not accepted as a regular payload file', verifyStagedFiles([{ path: 'model.bin', size: body.length, sha256 }], root).error === 'staged_file_not_regular');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
