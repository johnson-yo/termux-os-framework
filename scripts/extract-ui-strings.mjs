/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The administration sources, and the existing catalogs under web/admin/i18n/.
 * [OUTPUT]: Updated catalogs: every source string present as a key, existing translations kept.
 * [POS]: scripts/extract-ui-strings.mjs in termux-os-framework. Run after changing panel copy.
 *
 *        Translators should never have to read the source to find out what needs translating, and
 *        nobody should hand-copy strings between files. This walks the same component call sites the
 *        panel renders through, so what lands in a catalog is exactly what a user can see.
 *
 *        A string that disappears from the source is kept in the catalog rather than deleted: a
 *        release that renames a label should not throw away work already done in four languages.
 * [PROTOCOL]: Never overwrite an existing translation; only add missing keys.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCES = [
  'web/admin/app-core.js',
  'web/admin/admin-controls.js',
  'web/admin/setup.js',
  'web/admin/login.js',
  'src/system/admin-pages.mjs',
  // 服务端也会下发用户看得见的文字（凭证说明、操作提示），它们同样要能翻译。
  'src/server.mjs',
  'web/admin/index.html',
  'web/admin/login.html',
  'web/admin/setup.html',
];
const CATALOG_DIR = path.join(ROOT, 'web/admin/i18n');

// 界面文字只从这些出口产生，所以只在这些调用点上提取。
const CALL_SITES = [
  /(?:section|valueRow|statusRow|actionButton|linkButton|pageLink|text|tr)\(\s*(?:'(?:p|b|h2|h3|span|small|summary|code|div|pre)',\s*)?'([^']+)'/g,
  /(?:title|label|description|textContent|placeholder):\s*'([^']+)'/g,
  // textContent = '…' / placeholder = '…'：直接赋值也是界面文字，先前漏了这一类，
  // 于是新加的控件文案不会进目录，翻译永远差那几条。
  /(?:textContent|placeholder|title)\s*=\s*'([^']+)'/g,
  /\['([^']+)',\s*/g,
  /\btext:\s*'([^']+)'/g,
  /\bnote:\s*'([^']+)'/g,
  // 三元分支的两个结果都是界面文字：`cond ? '甲' : '乙'`。先前只取到调用点的第一个
  // 字符串，于是所有「按状态给不同说法」的文案都不会进目录。
  /\?\s*'([^']*[\u4e00-\u9fff][^']*)'/g,
  /:\s*'([^']*[\u4e00-\u9fff][^']*)'\s*[,)]/g,
  // 静态 HTML：标签内的整段文字与几个属性。
  />([^<>{}]*[\u4e00-\u9fff][^<>{}]*)</g,
  /(?:aria-label|placeholder|title)="([^"]*[\u4e00-\u9fff][^"]*)"/g,
];

const hasHan = (value) => /[一-鿿]/.test(value);

const strings = new Set();
for (const relative of SOURCES) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const pattern of CALL_SITES) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      // 只收真正的界面文字：类名、标签名、协议值都不是。
      if (hasHan(value)) strings.add(value);
    }
  }
}

const ordered = [...strings].sort((a, b) => a.localeCompare(b, 'zh-Hans'));
fs.mkdirSync(CATALOG_DIR, { recursive: true });

let changed = 0;
for (const entry of fs.readdirSync(CATALOG_DIR)) {
  if (!entry.endsWith('.json')) continue;
  const file = path.join(CATALOG_DIR, entry);
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = {};
  for (const key of ordered) next[key] = existing[key] ?? '';
  // 源码里已经消失的词条保留在后面：改一次标签不该让四门语言的成果作废。
  for (const [key, value] of Object.entries(existing)) {
    if (!(key in next) && value) next[key] = value;
  }
  const before = JSON.stringify(existing);
  const after = JSON.stringify(next);
  if (before !== after) changed += 1;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const done = Object.values(next).filter(Boolean).length;
  console.log(`${entry}: ${done}/${ordered.length} translated`);
}

console.log(`${ordered.length} source strings; ${changed} catalog(s) updated`);

// --check：目录里少了源码中的词条就非零退出。没有这道检查，改一次文案就会
// 悄悄多出几条永远不会被翻译的字符串，而这件事只有用户切到那门语言才会发现。
if (process.argv.includes('--check') && changed > 0) {
  console.error('FAIL i18n catalogs are behind the sources; run: node scripts/extract-ui-strings.mjs');
  process.exit(1);
}
