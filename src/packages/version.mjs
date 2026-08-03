/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Version strings and the constraint syntax already used by `compatibility.framework`.
 * [OUTPUT]: `compareVersions`, `parseConstraint`, `satisfies`, and `CONSTRAINT_SYNTAX`.
 * [POS]: src/packages/version.mjs in termux-os-framework. The single comparator shared by manifest
 *        compatibility and dependency resolution, so two callers cannot disagree about what
 *        ">=0.2.0" means.
 * [PROTOCOL]: Deliberately not a semver range engine. Only ">=x.y.z" and "=x.y.z" are accepted; a
 *             richer grammar is a solver, and a solver is the thing this design refuses to become.
 *             Keep this English header synchronized with behavior and public contracts.
 */

/** 只認三段數字。前導 v、預發布尾巴、萬用字元一律不接受——看不懂就明說看不懂。 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CONSTRAINT = /^(>=|=)(\d+)\.(\d+)\.(\d+)$/;

export const CONSTRAINT_SYNTAX = '">=x.y.z" or "=x.y.z"';

export function parseVersion(value) {
  const m = VERSION.exec(String(value ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * @returns -1 / 0 / 1，任一側無法解析時回 `null`。
 *
 * ⚠ 無法解析回 `null` 而不是 0。回 0 會讓「版本讀不出來」與「版本剛好相等」
 * 給出同一個答案，於是一個壞掉的版本號會靜默通過所有 `>=` 檢查。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function parseConstraint(value) {
  const m = CONSTRAINT.exec(String(value ?? '').trim());
  return m ? { operator: m[1], version: `${m[2]}.${m[3]}.${m[4]}` } : null;
}

/**
 * @returns `true` / `false`，或 `null` 表示「答不出來」（約束或版本無法解析）。
 *
 * ⚠ 三態是刻意的。把「答不出來」壓成 `false` 會讓一個打錯的約束看起來像
 * 「依賴不滿足」，使用者去裝一個永遠裝不好的版本；壓成 `true` 更糟，門形同虛設。
 */
export function satisfies(version, constraint) {
  if (constraint === undefined || constraint === null || constraint === '') return true;
  const parsed = parseConstraint(constraint);
  if (!parsed) return null;
  const cmp = compareVersions(version, parsed.version);
  if (cmp === null) return null;
  return parsed.operator === '=' ? cmp === 0 : cmp >= 0;
}

// ============================================================
// 自檢：node src/packages/version.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve: resolvePath } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails += 1; };

  t('ordering is numeric, not lexicographic',
    compareVersions('0.2.10', '0.2.7') === 1 && compareVersions('0.2.7', '0.2.10') === -1);
  t('equal versions compare equal', compareVersions('1.0.0', '1.0.0') === 0);
  t('major beats minor beats patch',
    compareVersions('2.0.0', '1.9.9') === 1 && compareVersions('1.2.0', '1.1.9') === 1);

  // ⚠ 這一條是 registry `latest_version` 那個 bug 的同源護欄：字串序讓 0.2.7 排在
  // 0.2.10 前面，於是項目一進兩位數 patch 就永遠卡在舊版本，而發布端毫無異常。
  t('a two-digit patch does not regress below a one-digit patch',
    compareVersions('0.2.11', '0.2.9') === 1);

  t('an unreadable version compares to null, never to 0',
    compareVersions('1.0', '1.0.0') === null
    && compareVersions('v1.0.0', '1.0.0') === null
    && compareVersions('', '1.0.0') === null);

  t('">=" and "=" are the whole grammar',
    !!parseConstraint('>=1.2.3') && !!parseConstraint('=1.2.3')
    && !parseConstraint('^1.2.3') && !parseConstraint('~1.2.3')
    && !parseConstraint('1.2.3') && !parseConstraint('>1.2.3'));

  t('satisfies honours both operators',
    satisfies('1.2.3', '>=1.2.0') === true && satisfies('1.1.0', '>=1.2.0') === false
    && satisfies('1.2.3', '=1.2.3') === true && satisfies('1.2.4', '=1.2.3') === false);
  t('no constraint means no opinion', satisfies('1.0.0', undefined) === true && satisfies('1.0.0', '') === true);

  /**
   * ⭐ 三態不可壓成兩態。壓成 false，一個打錯的約束看起來像「依賴不滿足」，
   * 使用者會去裝一個永遠裝不好的版本；壓成 true 則門形同虛設。
   */
  t('unanswerable is its own answer, distinct from false',
    satisfies('1.0.0', '^1.0.0') === null && satisfies('not-a-version', '>=1.0.0') === null
    && satisfies('1.0.0', '>=2.0.0') === false);

  process.exit(fails ? 1 : 0);
}
