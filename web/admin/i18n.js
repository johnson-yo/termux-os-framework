/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The active language from the Framework, and a catalog served from /admin/i18n/<lang>.json.
 * [OUTPUT]: t(), which turns a source string into the active language.
 * [POS]: web/admin/i18n.js in termux-os-framework. A classic script loaded before the shell scripts.
 *
 *        The source string is the key, the way gettext uses msgid. Adding a language is adding one
 *        file of "source string" -> "translation"; nothing in the pages changes, and a string with
 *        no translation shows the original rather than a key like `admin.network.title`, which is
 *        what a half-finished catalog looks like when keys are invented.
 *
 *        Every user-facing string already passes through the shared components — section, text,
 *        valueRow, statusRow, actionButton, linkButton — so translation is applied there once
 *        instead of at each of the several hundred call sites.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

// 源语言就是代码里写的语言：它没有目录文件，也永远不缺词条。
const SOURCE_LANGUAGE = 'zh-Hans';

window.TermuxOSI18n = {
  language: SOURCE_LANGUAGE,
  catalog: new Map(),
  /** 已知语言。加一门语言 = 这里加一行 + 放一个 i18n/<code>.json。 */
  languages: [
    { code: 'zh-Hans', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
  ],
};

/**
 * 翻译一个界面字符串。
 *
 * 只处理字符串：组件也会用它包裹数字与节点，那些原样返回。查不到词条时返回原文——
 * 缺翻译的界面应该是「有一部分还是中文」，而不是「一片看不懂的键名」。
 */
function t(value) {
  if (typeof value !== 'string' || !value) return value;
  return window.TermuxOSI18n.catalog.get(value) ?? value;
}

/** 载入某个语言的目录。源语言没有文件，直接清空即可。 */
async function loadLanguage(code) {
  const language = code || SOURCE_LANGUAGE;
  window.TermuxOSI18n.language = language;
  window.TermuxOSI18n.catalog = new Map();
  document.documentElement.lang = language;
  if (language === SOURCE_LANGUAGE) return;
  try {
    const response = await fetch(`/admin/i18n/${encodeURIComponent(language)}.json`, { cache: 'no-cache' });
    if (!response.ok) return;
    const entries = await response.json();
    // 目录里多余或缺失的词条都不该让界面失败：缺的回落原文，多的忽略。
    for (const [key, translation] of Object.entries(entries)) {
      if (typeof translation === 'string' && translation) window.TermuxOSI18n.catalog.set(key, translation);
    }
  } catch {
    // 取不到目录就用源语言，而不是白屏。
  }
  translateStaticDom();
}

/**
 * 把页面里已经存在的静态文字换掉。
 *
 * index.html / login.html / setup.html 里的文字不经过组件，切换语言时会原样留在那里——
 * 一屏文字里夹着几句没变的，看上去像是没切成功。这里在目录载入后扫一次文本节点，
 * 只替换目录里有的，其余不动。
 */
function translateStaticDom(root = document.body) {
  if (!root || !window.TermuxOSI18n.catalog.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pending = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.textContent.trim();
    if (!value) continue;
    const translated = window.TermuxOSI18n.catalog.get(value);
    if (translated) pending.push([node, node.textContent.replace(value, translated)]);
  }
  for (const [node, value] of pending) node.textContent = value;
  for (const element of root.querySelectorAll('[aria-label],[placeholder],[title]')) {
    for (const attribute of ['aria-label', 'placeholder', 'title']) {
      const value = element.getAttribute(attribute);
      const translated = value && window.TermuxOSI18n.catalog.get(value.trim());
      if (translated) element.setAttribute(attribute, translated);
    }
  }
}

window.TermuxOSI18n.t = t;
window.TermuxOSI18n.load = loadLanguage;
window.TermuxOSI18n.translateStaticDom = translateStaticDom;
