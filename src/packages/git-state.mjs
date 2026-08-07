/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: An installed Package's active version directory and the `git` executable.
 * [OUTPUT]: `packageGitState`, `describeGitState`, `GIT_STATE`, and `gitAvailable`.
 * [POS]: src/packages/git-state.mjs in termux-os-framework. The only place that answers
 *        "is this Package released or being edited", read directly from the work tree so no
 *        second record of that fact can exist to disagree with it.
 * [PROTOCOL]: There is deliberately no state file here. A stored flag can be cleared while the
 *             edit survives, which is exactly the lie this module exists to prevent.
 *             Keep this English header synchronized with behavior and public contracts.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const GIT_STATE = {
  RELEASE: 'release',
  DEV: 'dev',
  UNKNOWN: 'unknown',
};

/**
 * 假 diff 的三个来源，全部在调用点关掉，而不是要求每台设备自己配对。
 *
 * `core.fileMode`：tar 解包后的权限位与仓库记录常常不一致，Android/Termux 上尤其如此，
 * 开着它会让整棵树看起来被改过。
 * `core.autocrlf`：仓库里若有 CRLF 或 `text=auto`，跨平台同样产生全树假 diff。
 * `core.quotepath`：关掉才能拿到原始字节的路径名，否则非 ASCII 文件名被转义，
 * 我们会把一个正常文件报成读不懂的路径。
 */
const GIT_FLAGS = [
  '-c', 'core.fileMode=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.quotepath=false',
];

const TIMEOUT_MS = 15_000;

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...GIT_FLAGS, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  });
}

export function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: TIMEOUT_MS });
    return true;
  } catch { return false; }
}

/** `git status --porcelain` 的一行 → 结构化条目。 */
function parsePorcelain(line) {
  if (line.length < 4) return null;
  const code = line.slice(0, 2);
  let target = line.slice(3);
  // 重命名/复制是 "R  old -> new"；我们关心的是新路径。
  const arrow = target.indexOf(' -> ');
  if (arrow >= 0) target = target.slice(arrow + 4);
  return { code, path: target, untracked: code === '??' };
}

/**
 * 这个包现在是 release 还是 dev。
 *
 * 判据只有一个：active 版本目录是不是一棵干净的 Git 工作树。tracked 或 untracked
 * 出现任何变化即 dev——不需要谁去执行「进入 dev」这个动作，改了就是改了。
 *
 * ⚠ 读不出来必须说读不出来。把 unknown 压成 release，一个坏掉的 Git 仓库会让升级
 * 覆盖掉使用者真实存在的修改；压成 dev 则每次升级都被无故拒绝。
 */
export function packageGitState(dir) {
  const base = { state: GIT_STATE.UNKNOWN, changes: [], ignored: [], error: null, reason: null };
  if (!dir || !fs.existsSync(dir)) {
    return { ...base, reason: 'missing_directory' };
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    // 没有 .git 不是错误：旧的 source_tar 包本来就没有 Git 身份。它只是无法用
    // 工作树回答这个问题，所以答案是 unknown 而不是 release。
    return { ...base, reason: 'not_a_git_worktree' };
  }
  let porcelain;
  try {
    porcelain = git(dir, ['status', '--porcelain']);
  } catch (e) {
    return { ...base, reason: 'git_failed', error: String(e?.stderr || e?.message || e).trim().slice(0, 400) };
  }
  const changes = porcelain.split('\n').map((l) => l.trimEnd()).filter(Boolean)
    .map(parsePorcelain).filter(Boolean);

  // Ignored 是单独一问。被 .gitignore 挡住的运行期写入不该让包变成 dev——那是污染
  // 不是开发——但它更不该完全看不见：一个包可以 ignore 掉自己写进工作树的东西，
  // 于是「污染了」和「干净」在 --porcelain 里长得一模一样。
  let ignored = [];
  try {
    ignored = git(dir, ['status', '--porcelain', '--ignored=matching'])
      .split('\n').map((l) => l.trimEnd()).filter((l) => l.startsWith('!! '))
      .map((l) => l.slice(3));
  } catch { /* 主判定已经成立，ignored 只是附加信息。 */ }

  return {
    state: changes.length ? GIT_STATE.DEV : GIT_STATE.RELEASE,
    changes,
    ignored,
    error: null,
    reason: changes.length ? 'worktree_modified' : 'worktree_clean',
  };
}

/** Git 身份：origin、具名分支、HEAD、是否 shallow。验收与报告用。 */
export function packageGitIdentity(dir) {
  const out = { origin: null, branch: null, head: null, shallow: false, error: null };
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return { ...out, error: 'not_a_git_worktree' };
  const read = (args) => { try { return git(dir, args).trim(); } catch { return null; } };
  out.origin = read(['remote', 'get-url', 'origin']);
  const branch = read(['branch', '--show-current']);
  // `--show-current` 在游离 HEAD 上返回空串。空串和 null 要分开：前者是「有 Git 但
  // 没在分支上」，正是 CI 必须避免的状态；后者是读不到。
  out.branch = branch === '' ? null : branch;
  out.detached = branch === '';
  out.head = read(['rev-parse', 'HEAD']);
  out.shallow = fs.existsSync(path.join(dir, '.git', 'shallow'))
    || read(['rev-parse', '--is-shallow-repository']) === 'true';
  return out;
}

/** 一行人类可读描述，给 CLI 与 WebUI 共用。 */
export function describeGitState(result) {
  if (!result) return 'unknown';
  if (result.state === GIT_STATE.RELEASE) {
    return result.ignored.length
      ? `release (⚠ ${result.ignored.length} ignored path(s) in the work tree)`
      : 'release';
  }
  if (result.state === GIT_STATE.DEV) return `dev (${result.changes.length} change(s))`;
  return `unknown (${result.reason}${result.error ? `: ${result.error}` : ''})`;
}

if (process.argv[1] && process.argv[1].endsWith('git-state.mjs') && process.argv.includes('--self-test')) {
  const os = await import('node:os');
  let fails = 0;
  const t = (name, ok) => { if (!ok) fails++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}`); };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-state-'));
  const repo = path.join(tmp, 'pkg');
  fs.mkdirSync(repo);

  t('a missing directory is unknown, never release',
    packageGitState(path.join(tmp, 'nope')).state === GIT_STATE.UNKNOWN);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  t('a plain directory without .git is unknown, never release',
    packageGitState(repo).state === GIT_STATE.UNKNOWN
    && packageGitState(repo).reason === 'not_a_git_worktree');

  if (!gitAvailable()) {
    console.log('ok git is unavailable; work-tree assertions skipped');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fails ? 1 : 0);
  }

  const run = (args) => execFileSync('git', ['-C', repo, ...GIT_FLAGS, ...args],
    { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' } });
  run(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'noise.log\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'baseline']);

  t('a clean work tree is release', packageGitState(repo).state === GIT_STATE.RELEASE);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const dirty = packageGitState(repo);
  t('a tracked edit is dev with the path named',
    dirty.state === GIT_STATE.DEV && dirty.changes.some((c) => c.path === 'a.txt'));
  run(['checkout', '--', 'a.txt']);

  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  const untracked = packageGitState(repo);
  t('an untracked file is dev too — added is changed',
    untracked.state === GIT_STATE.DEV && untracked.changes.some((c) => c.untracked && c.path === 'new.txt'));
  fs.rmSync(path.join(repo, 'new.txt'));

  fs.writeFileSync(path.join(repo, 'noise.log'), 'runtime\n');
  const polluted = packageGitState(repo);
  /**
   * ⭐ 被 ignore 的运行期写入不是 dev，但也不能隐形。
   * `.gitignore` 在包作者手里，于是「往工作树里写了东西」这件事可以被他自己屏蔽掉。
   * 判定仍是 release（作者确实没在开发），但污染必须报出来。
   */
  t('an ignored runtime write stays release yet is still reported',
    polluted.state === GIT_STATE.RELEASE && polluted.ignored.includes('noise.log')
    && describeGitState(polluted).includes('ignored'));
  fs.rmSync(path.join(repo, 'noise.log'));

  const identity = packageGitIdentity(repo);
  t('identity reports a named branch and a HEAD',
    identity.branch === 'main' && identity.detached === false && /^[0-9a-f]{40}$/.test(identity.head ?? ''));
  t('a full clone is not shallow', identity.shallow === false);

  run(['checkout', '-q', '--detach', 'HEAD']);
  t('a detached HEAD is visible as such, not reported as a branch',
    packageGitIdentity(repo).detached === true && packageGitIdentity(repo).branch === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
