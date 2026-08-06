/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/menu.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { CORE_ADMIN_PAGES } from './admin-pages.mjs';

const PACKAGE_PARENTS = new Set([
  '/admin/status', '/admin/applications', '/admin/services', '/admin/system', '/admin/packages', '/admin/adapters',
]);
const packagePath = (id) => `/packages/${id}/`;
const allowed = (node, installed, developerMode) =>
  (!node.required_package || installed.has(node.required_package))
  && (!node.developer_only || developerMode);

const packageMenu = (pkg) => Array.isArray(pkg.manifest?.menu)
  ? pkg.manifest.menu.filter((node) => node && node.path === packagePath(pkg.id) && PACKAGE_PARENTS.has(node.parent))
    .map((node) => ({ ...node, required_package: pkg.id, package: pkg.id }))
  : [];

export function buildAdminMenu({ packages = [], developerMode = false } = {}) {
  const installed = new Set(packages.filter((p) => p.status === 'loaded').map((p) => p.id));
  const contributed = packages.flatMap(packageMenu);
  const paths = new Set(CORE_ADMIN_PAGES.map((node) => node.path));
  const nodes = [...CORE_ADMIN_PAGES, ...contributed].filter((node) => {
    if (paths.has(node.path) && node.package) return false;
    paths.add(node.path);
    return allowed(node, installed, developerMode);
  })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const children = (parent = null) => nodes.filter((n) => (n.parent ?? null) === parent).map((n) => ({
    ...n,
    children: children(n.path),
  }));
  return { schema: 'termux-os.admin-menu.v1', menu: children() };
}

export const adminMenuHasPath = (menu, pathname) => {
  const walk = (nodes) => nodes.some((node) => node.path === pathname || walk(node.children ?? []));
  return walk(menu?.menu ?? []);
};

// node src/system/menu.mjs --self-test
const { fileURLToPath: selfTestUrl } = await import('node:url');
const { resolve: selfTestPath } = await import('node:path');
// ⚠ 只在**本檔被直接執行**時跑。少了 argv[1] 這半，任何 transitively import 本檔的
// 自檢都會被這一塊劫持並提前 process.exit——那個自檢的斷言一條也不會執行，
// 而輸出看起來完全正常，只是印的是別人的 PASS。
if (process.argv.includes('--self-test')
  && process.argv[1] && selfTestPath(process.argv[1]) === selfTestUrl(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
  const read = buildAdminMenu();
  const flat = read.menu.flatMap((x) => [x, ...x.children]);
  // 守的是順序本身，不是當下的標題文字——介面文案會改，導覽順序不該跟著改。
  t('fixed top-level order', read.menu.map((x) => x.path).join(',')
    === '/admin/status,/admin/applications,/admin/services,/admin/packages,/admin/adapters,/admin/system');
  t('core pages stay visible to every authenticated session', flat.some((x) => x.path === '/admin/system/administration'));
  t('Package Setting lives under Packages', flat.find((x) => x.path === '/admin/packages/settings')?.parent === '/admin/packages');
  t('Framework Update lives under System', flat.find((x) => x.path === '/admin/system/framework-update')?.parent === '/admin/system');
  // 工作區管理的是本機的包項目，屬於 Packages；與 System 的設備/框架設定無關。
  t('Workspace lives under Packages', flat.find((x) => x.path === '/admin/packages/workspace')?.parent === '/admin/packages');
  // Developer resources 只有一個外部連結，不值得占一個分頁——已併入 Workspace 標題行。
  t('retired developer resources page is gone', !flat.some((x) => x.path === '/admin/system/developer'));
  const pkg = { id: 'github.termux-os.service.example', status: 'loaded', manifest: { menu: [{
    parent: '/admin/status', path: '/packages/github.termux-os.service.example/', title: 'Example', order: 40,
  }] } };
  const withPackage = buildAdminMenu({ packages: [pkg] });
  t('Package menu only appears with its loaded owner', adminMenuHasPath(withPackage, pkg.manifest.menu[0].path));
  process.exit(fails ? 1 : 0);
}
