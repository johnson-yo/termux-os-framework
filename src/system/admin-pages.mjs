/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/admin-pages.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export const CORE_ADMIN_PAGES = [
  { path: '/admin/status', title: 'Status', order: 10, default_child: '/admin/status/overview' },
  { path: '/admin/status/overview', parent: '/admin/status', title: 'Overview', order: 10,
    description: 'See the current control state first, then the reasons and actions behind it.', renderer: 'overview' },
  { path: '/admin/status/logs', parent: '/admin/status', title: 'Logs', order: 20,
    description: 'Start from a point in time and follow new output without altering stored logs.', renderer: 'logs' },
  { path: '/admin/status/runtime', parent: '/admin/status', title: 'Runtime', order: 30,
    description: 'Compare desired state, process state, health, and the loaded source.', renderer: 'runtime' },
  { path: '/admin/applications', title: 'Applications', order: 20,
    description: 'Open installed applications and inspect readiness before launching them.', renderer: 'applications' },
  { path: '/admin/services', title: 'Services', order: 30, default_child: '/admin/services/overview' },
  { path: '/admin/services/overview', parent: '/admin/services', title: 'Service Overview', order: 10,
    description: 'Control managed services: intent, process state, health, and recent activity.', renderer: 'services' },
  { path: '/admin/packages', title: 'Packages', order: 40, default_child: '/admin/packages/overview' },
  { path: '/admin/packages/overview', parent: '/admin/packages', title: 'Packages', order: 10,
    description: 'Manage installed Packages, choose verified Packages from the catalog, or install one from a file.', renderer: 'packages' },
  { path: '/admin/packages/settings', parent: '/admin/packages', title: 'Package Setting', order: 20,
    description: 'Edit Package ports and visibility, then restart, disable, or enable each Package.', renderer: 'package_settings' },
  { path: '/admin/adapters', title: 'Adapters', order: 50, default_child: '/admin/adapters/overview' },
  { path: '/admin/adapters/overview', parent: '/admin/adapters', title: 'Adapter Catalog', order: 10,
    description: 'Inspect installed bridges between Packages, devices, engines, and external APIs.', renderer: 'adapters' },
  { path: '/admin/system', title: 'System', order: 60, default_child: '/admin/system/system' },
  { path: '/admin/system/system', parent: '/admin/system', title: 'System', order: 10,
    description: 'Device facts and the exact Framework build currently running.', renderer: 'system' },
  { path: '/admin/system/administration', parent: '/admin/system', title: 'Administration', order: 20,
    description: 'Manage the Browser Session, System Key, login password, and reachable control-center addresses.', renderer: 'administration' },
  { path: '/admin/system/framework-update', parent: '/admin/system', title: 'Framework Update', order: 30,
    description: 'Upload a Framework update file; it is checked first, and a failed update restores the previous version.', renderer: 'framework_update' },
  { path: '/admin/system/workspace', parent: '/admin/system', title: 'Workspace', order: 40,
    description: 'Packages under development on this device. A workspace runs alongside the released package of the same id, and every page it serves is listed with a direct link.',
    renderer: 'workspace' },
  { path: '/admin/system/developer', parent: '/admin/system', title: 'Developer resources', order: 50,
    description: 'Open the public Package developer portal for submission, review, and history.', renderer: 'developer_resources' },
];

export const coreAdminPage = (pathname) => CORE_ADMIN_PAGES.find((page) => page.path === pathname) ?? null;
