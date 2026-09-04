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
 *             complete and report a plausible Content-Length. It is therefore computed over
 *             **exactly the bytes that landed**: streamed for fresh bytes, and — when a partial
 *             file is resumed — replayed over the prefix already on disk before streaming the
 *             rest. A digest that skipped the prefix would attest to something that was never
 *             checked, which is worse than no digest at all.
 *             Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 資產檔案的來源主機。⭐ **它是 BOM 的一部分，⛔ 不是猜出來的。**
 *
 * ⚠ 這一欄之前不存在，而 `assetFileUrl` 兩條分支都把 `huggingface` 寫死了——
 *   於是資產層**在結構上只支持 HF**，而那件事在任何地方都沒有寫下來。
 * ⚠ 省略時為 `huggingface`：既有的每一份 manifest 都是那樣的，
 *   ⛔ 加這一欄不許讓任何已發布的包失效。
 */
export const DEFAULT_ASSET_HOST = 'huggingface';

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * 每個主機兩件事：直連怎麼拼，以及在 Catalog 裡它叫什麼 `kind`。
 * ⚠ `kind` 不是我們定的——Catalog 按 `(repository, revision, file_path, kind)` 逐條批准，
 *   給錯就是 `FILE_NOT_ALLOWED`，而那個失敗看起來像「這個檔案沒登記」。
 */
const ASSET_HOSTS = Object.freeze({
  huggingface: Object.freeze({
    registry_kind: 'model_file',
    direct: (file, remotePath) =>
      `https://huggingface.co/${file.repo}/resolve/${file.revision}/${encodePath(remotePath)}`,
  }),
  github: Object.freeze({
    registry_kind: 'repository_file',
    direct: (file, remotePath) =>
      `https://raw.githubusercontent.com/${file.repo}/${file.revision}/${encodePath(remotePath)}`,
  }),
});

export const assetFileHost = (file) => (file?.host ?? DEFAULT_ASSET_HOST);

export const isKnownAssetHost = (host) => Object.hasOwn(ASSET_HOSTS, String(host ?? ''));

/**
 * 一個來源檔案的下載地址。
 *
 * ⭐ 兩種取法**同一個坐標**：`registry` 走我們的 Catalog（白名單 + 主機限制 + 可觀測），
 * `direct` 直連上游。兩者拿到的是同一個 revision 下的同一個路徑，
 * 所以 sha256 對得上就是對得上——這正是「先直連、不通再走代理」能成立的全部理由。
 */
export function assetFileUrl(file, { via = 'registry', registryBase = '' } = {}) {
  const remotePath = file.remote_path ?? file.path;
  const host = assetFileHost(file);
  const spec = ASSET_HOSTS[host];
  if (!spec) throw new Error(`asset file ${file.path}: unknown source host "${host}"`);
  if (via === 'direct') return spec.direct(file, remotePath);
  const params = new URLSearchParams({
    source: host,
    repository: file.repo,
    version: file.revision,
    kind: spec.registry_kind,
    file: remotePath,
  });
  return `${registryBase}/download?${params}`;
}

const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** 直連的**建立連接 + 拿到響應頭**上限。⛔ 不是整條下載的上限——見 [openStream]。 */
export const DIRECT_HEAD_TIMEOUT_MS = 6000;
/** 開始傳輸之後，兩個數據塊之間允許的最長靜默。 */
export const STALL_TIMEOUT_MS = 45000;
/** 一個檔案在一次調用裡最多試幾次（跨路線合計）。 */
export const MAX_ATTEMPTS = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 發起請求，並且**只給「連上並拿到響應頭」計時**。
 *
 * ⚠ 直接用 `AbortSignal.timeout(6000)` 是錯的：那個信號會在 6 秒時把**整條下載**掐掉，
 *   而一份 937 MB 的資產本來就要跑好幾分鐘。⭐ **可達性的超時和傳輸的超時是兩件事**，
 *   合成一個就等於「大檔案永遠下不完」。
 * 故：`AbortController` + 一個在 `fetch()` 返回（＝響應頭到手）時就清掉的定時器。
 */
async function openStream(fetchImpl, url, { headers, headTimeoutMs, outerSignal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`no response within ${headTimeoutMs}ms`)), headTimeoutMs);
  try {
    const response = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal });
    return { response, controller, release: () => outerSignal?.removeEventListener?.('abort', onAbort) };
  } catch (error) {
    outerSignal?.removeEventListener?.('abort', onAbort);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 這次要走哪些路線，按順序試。
 *
 * ⭐ **預設先直連上游，不通才走 Catalog**（`auto`）。理由不是速度：
 *   兩條路拿到的是同一個 revision 下的同一個路徑，sha256 一樣，
 *   而代理是一個**額外的、會失敗的中間人**——能不經過就不經過。
 * ⛔ `direct` / `registry` 仍可顯式釘死：測量與排障要能指定走哪一條。
 */
function routesFor(via, registryBase) {
  if (via === 'direct') return ['direct'];
  if (via === 'registry') return ['registry'];
  return registryBase ? ['direct', 'registry'] : ['direct'];
}

/**
 * 把一組來源檔案取到 `destDir`。
 *
 * ⚠ 先寫 `.part` 再 rename：一個中途斷掉的下載絕不能以最終檔名存在，否則下一次
 * 「檔案在不在」會回答在，而它只是半個。
 *
 * ⚠ 已存在且 sha256 相符的檔案直接跳過——重裝同一版本不該重下 937 MB。
 * 但**必須真的算一遍**才算相符：只比大小會讓一個截斷到恰好長度的檔案矇混過去。
 *
 * ⭐ **`.part` 跨調用存活，因為它就是續傳的基礎。**
 *   實測：937 MB 在會斷的鏈路上死在 99 MB，而舊實現「斷了就刪、下次從 0 開始」——
 *   ⭐ **在會斷的鏈路上，「失敗即從頭再來」讓成功率隨檔案大小指數衰減**。
 * ⛔ 但一個**被證明是錯的**前綴必須立刻扔掉：整條下完而 sha256 不符時就地刪 `.part`，
 *   否則那個壞前綴會讓這個檔案**永遠**下不對，而每次的症狀都一樣。
 */
export async function fetchAssetFiles(files, destDir, {
  fetchImpl = fetch,
  via = 'auto',
  registryBase = '',
  onProgress = () => {},
  headers = {},
  signal = undefined,
  headTimeoutMs = DIRECT_HEAD_TIMEOUT_MS,
  stallTimeoutMs = STALL_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
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
    const routes = routesFor(via, registryBase);
    const attempts = [];
    let done = null;

    for (let attempt = 0; attempt < maxAttempts && !done; attempt += 1) {
      signal?.throwIfAborted?.();
      const route = routes[Math.min(attempt, routes.length - 1)];
      /**
       * ⚠ **最後一次一律從 0 開始。** 續傳的前提是盤上那段前綴是對的，而我們無法
       *   單獨驗證它。⭐ 給它留一條「扔掉前綴重來」的出口，一個壞前綴就不可能
       *   把這個檔案變成永久下不對——⛔ 沒有這條，故障會表現為「每次都失敗且原因相同」。
       */
      const lastChance = attempt === maxAttempts - 1;
      if (lastChance) fs.rmSync(temporary, { force: true });
      const have = fs.existsSync(temporary) ? fs.statSync(temporary).size : 0;
      const resuming = have > 0 && have < file.size;
      if (have >= file.size) { fs.rmSync(temporary, { force: true }); }

      const url = assetFileUrl(file, { via: route, registryBase });
      onProgress({
        file: file.path, stage: attempt === 0 ? 'start' : 'retry',
        bytes: resuming ? have : 0, total: file.size, url, route, attempt: attempt + 1,
      });

      let opened = null;
      try {
        opened = await openStream(fetchImpl, url, {
          headers: resuming ? { ...headers, Range: `bytes=${have}-` } : headers,
          headTimeoutMs, outerSignal: signal,
        });
        const { response } = opened;
        if (!response.ok || !response.body) {
          throw new Error(`asset file ${file.path}: HTTP ${response.status} from ${file.repo} via ${route}`);
        }
        /**
         * ⚠ 請求了 Range 卻拿回 200 ＝ 對端不支持續傳，它會從頭再發一遍。
         *   ⭐ 那就從頭收：⛔ 把全量響應追加到已有前綴後面是這裡最容易犯、
         *   也最難查的錯（檔案會恰好變成 `have + size` 字節）。
         */
        const appended = resuming && response.status === 206;
        const hash = crypto.createHash('sha256');
        let written = 0;
        if (appended) {
          // ⭐ 摘要必須覆蓋**真正落盤的每一個字節**，所以先把前綴喂進去。
          const fd = fs.openSync(temporary, 'r');
          try {
            const buf = Buffer.alloc(1024 * 1024);
            let n;
            while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
          } finally { fs.closeSync(fd); }
          written = have;
        }
        const handle = fs.openSync(temporary, appended ? 'a' : 'w', 0o600);
        let stallTimer = null;
        const armStall = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(
            () => opened.controller.abort(new Error(`no data for ${stallTimeoutMs}ms`)), stallTimeoutMs);
        };
        try {
          armStall();
          for await (const chunk of response.body) {
            signal?.throwIfAborted?.();
            const buffer = Buffer.from(chunk);
            hash.update(buffer);
            fs.writeSync(handle, buffer);
            written += buffer.length;
            armStall();
            onProgress({ file: file.path, stage: 'progress', bytes: written, total: file.size, route });
          }
          fs.fsyncSync(handle);
        } finally { clearTimeout(stallTimer); fs.closeSync(handle); }

        const digest = hash.digest('hex');
        if (written === file.size && digest === file.sha256) {
          fs.renameSync(temporary, target);
          landed.push({ ...file, path: target, reused: false, route, attempts: attempt + 1 });
          onProgress({ file: file.path, stage: 'done', bytes: written, total: file.size, route });
          done = true;
          break;
        }
        /**
         * ⛔ 整條收完了、長度也對，但 sha256 不符 ⇒ 前綴**被證明是錯的**，就地扔掉。
         *   留著它等於讓每一次續傳都從一段壞數據上接著長。
         */
        if (written >= file.size) fs.rmSync(temporary, { force: true });
        throw new Error(written !== file.size
          ? `asset file ${file.path}: got ${written} bytes, declared ${file.size}`
          : `asset file ${file.path}: sha256 ${digest.slice(0, 16)}… does not match declared ${file.sha256.slice(0, 16)}…`);
      } catch (error) {
        signal?.throwIfAborted?.();
        attempts.push({ route, detail: String(error?.message ?? error) });
        onProgress({ file: file.path, stage: 'attempt_failed', route, attempt: attempt + 1,
          detail: String(error?.message ?? error) });
        if (attempt === maxAttempts - 1) {
          /**
           * ⚠ 徹底失敗時**不刪** `.part`：它是下一次調用的續傳基礎，而那正是
           *   大資產能最終下完的唯一原因。⛔ 它永遠不會被誤認成完整檔案——
           *   它叫 `.part`，而「檔案在不在」問的是最終檔名。
           */
          const summary = attempts.map((a) => `${a.route}: ${a.detail}`).join(' | ');
          throw new Error(`asset file ${file.path}: every download attempt failed — ${summary}`);
        }
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
      } finally {
        opened?.release?.();
      }
    }
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
  let landed = await fetchAssetFiles([file], dest, { via: 'direct', fetchImpl: async () => streamOf(body) });
  t('a verified file lands under its declared name',
    landed[0].reused === false && fs.readFileSync(path.join(dest, 'm.bin')).equals(body));
  t('no .part file survives a successful download',
    !fs.existsSync(path.join(dest, 'm.bin.part')));

  // --- 重装同一版本不重下 ---
  let calls = 0;
  landed = await fetchAssetFiles([file], dest, { via: 'direct', fetchImpl: async () => { calls += 1; return streamOf(body); } });
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
    await fetchAssetFiles([file], dest2, { via: 'direct', maxAttempts: 1, fetchImpl: async () => streamOf(truncated) });
  } catch (e) { error = e; }
  t('a truncated download is refused', /got 5 bytes, declared 17/.test(String(error?.message)));
  /**
   * ⚠ 這一條原本斷言「連 `.part` 都不許留下」。⭐ 它的**本意**是「半個檔案絕不能冒充完整」，
   *   而那條保證來自**檔名**：`.part` 永遠不會被 rename，「檔案在不在」問的是最終檔名。
   *   續傳把 `.part` 變成了下一次的起點——實測 937 MB 在會斷的鏈路上死在 99 MB，
   *   而「斷了就刪」讓每一次都從 0 開始。故按本意收緊為：⛔ 不許留下**能被誤認為完整**的東西。
   */
  t('a refused download never leaves anything that can be mistaken for the finished file',
    !fs.existsSync(path.join(dest2, 'm.bin')));

  // A stream can fail after writing bytes, which is the failure shape that
  // used to leave the logical fetch locked until the process was restarted.
  const destStreamFailure = path.join(tmp, 'stream-failure');
  error = null;
  try {
    await fetchAssetFiles([file], destStreamFailure, {
      via: 'direct', maxAttempts: 1,
      fetchImpl: async () => ({
        ok: true, status: 200,
        body: (async function* broken() {
          yield body.subarray(0, 5);
          throw new Error('controlled stream failure');
        }()),
      }),
    });
  } catch (e) { error = e; }
  /**
   * ⭐ 傳輸中斷之後 `.part` **必須留下來**——它就是續傳的基礎。
   *   ⛔ 舊實現在這裡刪掉它，於是下一次調用從 0 開始；
   *   ⭐ **在會斷的鏈路上，「失敗即從頭再來」讓成功率隨檔案大小指數衰減。**
   */
  t('a stream failure is surfaced and keeps its .part as the resume base',
    /controlled stream failure/.test(String(error?.message))
      && fs.statSync(path.join(destStreamFailure, 'm.bin.part')).size === 5);
  landed = await fetchAssetFiles([file], destStreamFailure, {
    via: 'direct',
    fetchImpl: async () => streamOf(body),
  });
  t('the same asset can be retried after a stream failure',
    landed[0].reused === false && fs.readFileSync(path.join(destStreamFailure, 'm.bin')).equals(body));

  // 长度对但内容不对：只比大小的实现会放它过去。
  const wrong = Buffer.from('HELLO ASSET WORLD');
  error = null;
  try {
    await fetchAssetFiles([file], path.join(tmp, 'store3'), { via: 'direct', maxAttempts: 1, fetchImpl: async () => streamOf(wrong) });
  } catch (e) { error = e; }
  t('a same-size but different body is refused, which a size check alone would miss',
    /sha256/.test(String(error?.message)));

  // 盘上已有一个同名但错的文件：必须重下，不能因为「文件在」就当就位。
  const dest4 = path.join(tmp, 'store4');
  fs.mkdirSync(dest4, { recursive: true });
  fs.writeFileSync(path.join(dest4, 'm.bin'), wrong);
  landed = await fetchAssetFiles([file], dest4, { via: 'direct', fetchImpl: async () => streamOf(body) });
  t('an existing file with the wrong hash is replaced, not trusted',
    landed[0].reused === false && fs.readFileSync(path.join(dest4, 'm.bin')).equals(body));

  // ── 来源主机：BOM 说了算，⛔ 不猜 ──────────────────────────────
  const ghFile = { ...file, host: 'github' };
  t('a GitHub-hosted asset resolves to raw.githubusercontent, not huggingface',
    assetFileUrl(ghFile, { via: 'direct' })
      === `https://raw.githubusercontent.com/owner/repo/${'a'.repeat(40)}/m.bin`);
  t('a GitHub-hosted asset asks the catalog for the right kind',
    assetFileUrl(ghFile, { registryBase: 'https://r.example' }).includes('kind=repository_file')
      && assetFileUrl(ghFile, { registryBase: 'https://r.example' }).includes('source=github'));
  t('an omitted host still means huggingface — no published manifest may break',
    assetFileHost(file) === 'huggingface' && assetFileUrl(file, { via: 'direct' }).includes('huggingface.co'));
  let hostError = null;
  try { assetFileUrl({ ...file, host: 'gitlab' }, { via: 'direct' }); } catch (e) { hostError = e; }
  t('an unknown host fails loudly instead of silently defaulting',
    /unknown source host "gitlab"/.test(String(hostError?.message)));

  // ── 直连优先，超时才转代理 ────────────────────────────────────
  const seen = [];
  const destAuto = path.join(tmp, 'auto');
  landed = await fetchAssetFiles([file], destAuto, {
    registryBase: 'https://r.example',
    headTimeoutMs: 20,
    fetchImpl: async (url, opts) => {
      seen.push(url);
      // 直连「连不上」：永不返回响应头，让 head 超时把它掐掉
      if (url.startsWith('https://huggingface.co/')) {
        return new Promise((_, reject) => opts.signal?.addEventListener('abort',
          () => reject(opts.signal.reason ?? new Error('aborted')), { once: true }));
      }
      return streamOf(body);
    },
  });
  t('direct is tried first, and the catalog only after it times out',
    seen.length === 2 && seen[0].startsWith('https://huggingface.co/')
      && seen[1].startsWith('https://r.example/download?')
      && landed[0].route === 'registry');
  t('the bytes are the same either way, so the digest still decides',
    fs.readFileSync(path.join(destAuto, 'm.bin')).equals(body));

  const seenDirect = [];
  const destAuto2 = path.join(tmp, 'auto2');
  landed = await fetchAssetFiles([file], destAuto2, {
    registryBase: 'https://r.example',
    fetchImpl: async (url) => { seenDirect.push(url); return streamOf(body); },
  });
  t('a reachable upstream is never proxied — the catalog is a fallback, not a toll booth',
    seenDirect.length === 1 && seenDirect[0].startsWith('https://huggingface.co/')
      && landed[0].route === 'direct');

  /**
   * ⭐ 没有 Catalog 地址时 `auto` 退化成只有直连——可用，但**少了一条退路**，
   *   而那件事必须说得出来，⛔ 不能只在源码里成立。
   */
  const destNoBase = path.join(tmp, 'auto-nobase');
  const seenNoBase = [];
  await fetchAssetFiles([file], destNoBase, {
    fetchImpl: async (url) => { seenNoBase.push(url); return streamOf(body); },
  });
  t('without a catalog address auto uses direct only, and asks for nothing else',
    seenNoBase.length === 1 && seenNoBase[0].startsWith('https://huggingface.co/'));

  // ── 断点续传 ──────────────────────────────────────────────────
  const destResume = path.join(tmp, 'resume');
  const ranges = [];
  let firstTry = true;
  landed = await fetchAssetFiles([file], destResume, {
    via: 'direct',
    fetchImpl: async (_url, opts) => {
      ranges.push(opts.headers?.Range ?? null);
      if (firstTry) {
        firstTry = false;
        return { ok: true, status: 200, body: (async function* half() {
          yield body.subarray(0, 9);
          throw new Error('link dropped');
        }()) };
      }
      // 206：只发剩下的那一段
      return { ok: true, status: 206, body: (async function* rest() { yield body.subarray(9); }()) };
    },
  });
  t('an interrupted download resumes from where it stopped, asking for the rest by Range',
    ranges.length === 2 && ranges[0] === null && ranges[1] === 'bytes=9-');
  t('a resumed file is byte-for-byte correct, and its digest covered the prefix too',
    landed[0].reused === false && fs.readFileSync(path.join(destResume, 'm.bin')).equals(body));

  /**
   * ⚠ 请求了 Range 却拿回 200 ＝ 对端不支持续传，它会**从头再发一遍**。
   *   ⭐ 把全量响应追加到已有前缀后面是这里最容易犯、也最难查的错：
   *   文件会恰好变成 `have + size` 字节，而每一步看起来都很正常。
   */
  const destIgnore = path.join(tmp, 'range-ignored');
  fs.mkdirSync(destIgnore, { recursive: true });
  fs.writeFileSync(path.join(destIgnore, 'm.bin.part'), body.subarray(0, 9));
  landed = await fetchAssetFiles([file], destIgnore, {
    via: 'direct',
    fetchImpl: async () => streamOf(body),   // 无视 Range，回 200 全量
  });
  t('a server that ignores Range restarts the file instead of appending to the prefix',
    fs.readFileSync(path.join(destIgnore, 'm.bin')).equals(body));

  /**
   * ⭐ 一个**被证明是错的**前缀不许把这个文件变成永久下不对。
   *   最后一次一律从 0 开始，⛔ 没有这条，故障会表现为「每次都失败且原因相同」。
   */
  const destPoison = path.join(tmp, 'poisoned');
  fs.mkdirSync(destPoison, { recursive: true });
  fs.writeFileSync(path.join(destPoison, 'm.bin.part'), Buffer.from('XXXXXXXXX'));
  landed = await fetchAssetFiles([file], destPoison, {
    via: 'direct', maxAttempts: 2,
    fetchImpl: async (_u, opts) => (opts.headers?.Range
      ? { ok: true, status: 206, body: (async function* r() { yield body.subarray(9); }()) }
      : streamOf(body)),
  });
  t('a poisoned prefix is thrown away rather than resumed forever',
    fs.readFileSync(path.join(destPoison, 'm.bin')).equals(body));

  const space = checkFreeSpace(tmp, 1024);
  t('free space is reported, and an unknowable filesystem does not block', space.ok === true);
  t('an impossible request is refused up front',
    checkFreeSpace(tmp, Number.MAX_SAFE_INTEGER).ok === false);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
