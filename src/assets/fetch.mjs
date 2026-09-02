/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An `assets.provides[].source` BOM, a resolved store directory, and a URL builder.
 * [OUTPUT]: `assetFileUrl`, `fetchAssetFiles` — files landed in the store, each verified while it
 *           was being written.
 * [POS]: src/assets/fetch.mjs in termux-os-framework. The non-archive acquisition path: a large
 *        model is fetched file by file from where it already lives, instead of being repackaged
 *        into a tarball that would duplicate every byte.
 * [PROTOCOL]: The hash is an integrity check, not a security boundary — HTTPS and an immutable
 *             revision already establish who served the bytes and that the revision cannot change
 *             under us. What it actually catches is truncation: a resumed download can look
 *             complete and report a plausible Content-Length. It is therefore computed **while
 *             streaming**, never as a second pass over the file.
 *             Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 一個來源檔案的下載地址。
 *
 * ⭐ 兩種取法**同一個坐標**：`registry` 走我們的 Catalog（白名單 + 主機限制 + 可觀測），
 * `direct` 直連上游。前者是預設，後者只在 Catalog 夠不到時當退路——
 * 兩者拿到的是同一個 revision 下的同一個路徑，所以 sha256 對得上就是對得上。
 */
export function assetFileUrl(file, { via = 'registry', registryBase = '' } = {}) {
  const remotePath = file.remote_path ?? file.path;
  if (via === 'direct') {
    return `https://huggingface.co/${file.repo}/resolve/${file.revision}/${remotePath.split('/').map(encodeURIComponent).join('/')}`;
  }
  const params = new URLSearchParams({
    source: 'huggingface',
    repository: file.repo,
    version: file.revision,
    kind: 'model_file',
    file: remotePath,
  });
  return `${registryBase}/download?${params}`;
}

const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 把一組來源檔案取到 `destDir`。
 *
 * ⚠ 先寫 `.part` 再 rename：一個中途斷掉的下載絕不能以最終檔名存在，否則下一次
 * 「檔案在不在」會回答在，而它只是半個。
 *
 * ⚠ 已存在且 sha256 相符的檔案直接跳過——重裝同一版本不該重下 937 MB。
 * 但**必須真的算一遍**才算相符：只比大小會讓一個截斷到恰好長度的檔案矇混過去。
 */
export async function fetchAssetFiles(files, destDir, {
  fetchImpl = fetch,
  via = 'registry',
  registryBase = '',
  onProgress = () => {},
  headers = {},
  signal = undefined,
} = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const landed = [];
  for (const file of files) {
    const target = path.join(destDir, file.path);
    if (fs.existsSync(target) && sha256Of(target) === file.sha256) {
      landed.push({ ...file, path: target, reused: true });
      onProgress({ file: file.path, stage: 'reused', bytes: file.size });
      continue;
    }
    const temporary = `${target}.part`;
    const url = assetFileUrl(file, { via, registryBase });
    onProgress({ file: file.path, stage: 'start', bytes: 0, total: file.size, url });

    const response = await fetchImpl(url, { headers, redirect: 'follow', signal });
    if (!response.ok || !response.body) {
      throw new Error(`asset file ${file.path}: HTTP ${response.status} from ${file.repo}`);
    }
    const hash = crypto.createHash('sha256');
    let written = 0;
    const handle = fs.openSync(temporary, 'w', 0o600);
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted?.();
        const buffer = Buffer.from(chunk);
        hash.update(buffer);
        fs.writeSync(handle, buffer);
        written += buffer.length;
        onProgress({ file: file.path, stage: 'progress', bytes: written, total: file.size });
      }
      fs.fsyncSync(handle);
    } catch (error) {
      // A transport error or an explicit reconcile must never leave a .part
      // file that a later retry could mistake for progress.
      fs.rmSync(temporary, { force: true });
      throw error;
    } finally { fs.closeSync(handle); }

    const digest = hash.digest('hex');
    // ⛔ 不符就刪 `.part`，不留半個檔案在盤上冒充完整。
    if (written !== file.size || digest !== file.sha256) {
      fs.rmSync(temporary, { force: true });
      throw new Error(written !== file.size
        ? `asset file ${file.path}: got ${written} bytes, declared ${file.size}`
        : `asset file ${file.path}: sha256 ${digest.slice(0, 16)}… does not match declared ${file.sha256.slice(0, 16)}…`);
    }
    fs.renameSync(temporary, target);
    landed.push({ ...file, path: target, reused: false });
    onProgress({ file: file.path, stage: 'done', bytes: written, total: file.size });
  }
  return landed;
}

export function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read;
    while ((read = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(handle); }
  return hash.digest('hex');
}

/** 下載這組檔案還需要多少字節（已就位且校驗通過的不算）。 */
export function pendingBytes(files, destDir) {
  return files.reduce((sum, file) => {
    const target = path.join(destDir, file.path);
    if (fs.existsSync(target) && sha256Of(target) === file.sha256) return sum;
    return sum + file.size;
  }, 0);
}

/**
 * 空間夠不夠。⚠ 目前整條安裝鏈**一處空間檢查都沒有**——2 MB 時無所謂，
 * 937 MB 時寫到一半沒空間，留下的是一個誰也解釋不了的半成品。
 */
export function checkFreeSpace(destDir, needBytes) {
  let statfs;
  try { statfs = fs.statfsSync(destDir); } catch { return { known: false, ok: true }; }
  const free = Number(statfs.bavail) * Number(statfs.bsize);
  // 留 5% 餘量：填滿檔案系統會讓別的東西跟著壞，而那與這次安裝無關。
  const usable = free * 0.95;
  return { known: true, ok: usable >= needBytes, free_bytes: free, need_bytes: needBytes };
}

export { bytesEqual };

// ============================================================
// 自檢：node src/assets/fetch.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve: resolvePath } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails += 1; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assetfetch-'));
  const body = Buffer.from('hello asset world');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const file = {
    path: 'm.bin', repo: 'owner/repo', revision: 'a'.repeat(40),
    size: body.length, sha256: sha,
  };
  const streamOf = (buf) => ({
    ok: true,
    status: 200,
    body: (async function* gen() { yield buf.subarray(0, 5); yield buf.subarray(5); }()),
  });

  // --- URL：两种取法同一个坐标 ---
  t('a registry URL carries the pinned revision as the version',
    assetFileUrl(file, { registryBase: 'https://r.example' })
      === `https://r.example/download?source=huggingface&repository=owner%2Frepo&version=${'a'.repeat(40)}&kind=model_file&file=m.bin`);
  t('a direct URL resolves the same revision and path',
    assetFileUrl(file, { via: 'direct' })
      === `https://huggingface.co/owner/repo/resolve/${'a'.repeat(40)}/m.bin`);
  t('remote_path may differ from the name it lands under',
    assetFileUrl({ ...file, remote_path: 'sub/dir/x.bin' }, { via: 'direct' })
      .endsWith('/sub/dir/x.bin'));

  // --- 正常落盘 ---
  const dest = path.join(tmp, 'store');
  let landed = await fetchAssetFiles([file], dest, { fetchImpl: async () => streamOf(body) });
  t('a verified file lands under its declared name',
    landed[0].reused === false && fs.readFileSync(path.join(dest, 'm.bin')).equals(body));
  t('no .part file survives a successful download',
    !fs.existsSync(path.join(dest, 'm.bin.part')));

  // --- 重装同一版本不重下 ---
  let calls = 0;
  landed = await fetchAssetFiles([file], dest, { fetchImpl: async () => { calls += 1; return streamOf(body); } });
  t('an already-correct file is reused without a request', landed[0].reused === true && calls === 0);
  t('pendingBytes counts only what is still missing', pendingBytes([file], dest) === 0);

  /**
   * ⭐ 截断是这个校验存在的全部理由：HTTPS 与不可变 revision 已经保证了「谁给的」
   * 与「内容不会被换」，但一个断线续传的下载会长得像完整的。
   */
  const truncated = body.subarray(0, 5);
  const dest2 = path.join(tmp, 'store2');
  let error = null;
  try {
    await fetchAssetFiles([file], dest2, { fetchImpl: async () => streamOf(truncated) });
  } catch (e) { error = e; }
  t('a truncated download is refused', /got 5 bytes, declared 17/.test(String(error?.message)));
  t('a refused download leaves nothing behind, not even a .part',
    !fs.existsSync(path.join(dest2, 'm.bin')) && !fs.existsSync(path.join(dest2, 'm.bin.part')));

  // A stream can fail after writing bytes, which is the failure shape that
  // used to leave the logical fetch locked until the process was restarted.
  const destStreamFailure = path.join(tmp, 'stream-failure');
  error = null;
  try {
    await fetchAssetFiles([file], destStreamFailure, {
      fetchImpl: async () => ({
        ok: true, status: 200,
        body: (async function* broken() {
          yield body.subarray(0, 5);
          throw new Error('controlled stream failure');
        }()),
      }),
    });
  } catch (e) { error = e; }
  t('a stream failure is surfaced and removes its .part',
    /controlled stream failure/.test(String(error?.message))
      && !fs.existsSync(path.join(destStreamFailure, 'm.bin.part')));
  landed = await fetchAssetFiles([file], destStreamFailure, {
    fetchImpl: async () => streamOf(body),
  });
  t('the same asset can be retried after a stream failure',
    landed[0].reused === false && fs.readFileSync(path.join(destStreamFailure, 'm.bin')).equals(body));

  // 长度对但内容不对：只比大小的实现会放它过去。
  const wrong = Buffer.from('HELLO ASSET WORLD');
  error = null;
  try {
    await fetchAssetFiles([file], path.join(tmp, 'store3'), { fetchImpl: async () => streamOf(wrong) });
  } catch (e) { error = e; }
  t('a same-size but different body is refused, which a size check alone would miss',
    /sha256/.test(String(error?.message)));

  // 盘上已有一个同名但错的文件：必须重下，不能因为「文件在」就当就位。
  const dest4 = path.join(tmp, 'store4');
  fs.mkdirSync(dest4, { recursive: true });
  fs.writeFileSync(path.join(dest4, 'm.bin'), wrong);
  landed = await fetchAssetFiles([file], dest4, { fetchImpl: async () => streamOf(body) });
  t('an existing file with the wrong hash is replaced, not trusted',
    landed[0].reused === false && fs.readFileSync(path.join(dest4, 'm.bin')).equals(body));

  const space = checkFreeSpace(tmp, 1024);
  t('free space is reported, and an unknowable filesystem does not block', space.ok === true);
  t('an impossible request is refused up front',
    checkFreeSpace(tmp, Number.MAX_SAFE_INTEGER).ok === false);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
