/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/admin-pages.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

export const CORE_ADMIN_PAGES = [
  { path: '/admin/status', title: '状态', order: 10, default_child: '/admin/status/overview' },
  { path: '/admin/status/overview', parent: '/admin/status', title: '概览', order: 10,
    description: '先看当前的控制状态，再看背后的原因和可做的操作。', renderer: 'overview' },
  { path: '/admin/status/logs', parent: '/admin/status', title: '日志', order: 20,
    description: '从某个时间点开始跟随新输出，已存的日志不会被改动。这里也是操作进度与更新历史的去处。', renderer: 'logs' },
  { path: '/admin/status/runtime', parent: '/admin/status', title: '运行时', order: 30,
    description: '对照期望状态、进程状态、健康状况与已加载的来源。', renderer: 'runtime' },
  { path: '/admin/applications', title: '应用', order: 20,
    description: '打开已安装的应用，启动前可以先看它是否就绪。', renderer: 'applications' },
  { path: '/admin/services', title: '服务', order: 30, default_child: '/admin/services/overview' },
  { path: '/admin/services/overview', parent: '/admin/services', title: '服务总览', order: 10,
    description: '管理受管服务：期望状态、进程状态、健康与近期活动。', renderer: 'services' },
  { path: '/admin/packages', title: 'Package', order: 40, default_child: '/admin/packages/overview' },
  { path: '/admin/packages/overview', parent: '/admin/packages', title: 'Package 管理', order: 10,
    description: '管理已安装的 Package，从目录里选择已验证的 Package，或直接从文件安装。', renderer: 'packages' },
  { path: '/admin/packages/settings', parent: '/admin/packages', title: 'Package 设置', order: 20,
    description: '修改 Package 的端口与可见性，然后重启、停用或启用它。', renderer: 'package_settings' },
  // 工作區屬於 Packages：它管理的是本機的包項目，與 System 的設備/框架設定無關。
  { path: '/admin/packages/workspace', parent: '/admin/packages', title: '工作区', order: 30,
    description: '这台设备上的 Package 项目。挂载后，项目会与同名的正式版并存运行，它提供的每个页面都会列出直达链接。',
    renderer: 'workspace' },
  { path: '/admin/adapters', title: 'Adapter', order: 50, default_child: '/admin/adapters/overview' },
  { path: '/admin/adapters/overview', parent: '/admin/adapters', title: 'Adapter 目录', order: 10,
    description: '查看已安装的桥接：Package 与设备、引擎、外部 API 之间的连接。', renderer: 'adapters' },
  { path: '/admin/system', title: '系统', order: 60, default_child: '/admin/system/system' },
  { path: '/admin/system/system', parent: '/admin/system', title: '系统信息', order: 10,
    description: '设备信息，以及当前正在运行的确切 Framework 构建。', renderer: 'system' },
  { path: '/admin/system/administration', parent: '/admin/system', title: '管理', order: 20,
    description: '管理浏览器会话、System Key、登录密码，以及控制台的监听地址与端口。', renderer: 'administration' },
  { path: '/admin/system/framework-update', parent: '/admin/system', title: 'Framework 更新', order: 30,
    description: '更新到已验证的 Framework 版本，或从文件安装。更新失败会自动恢复上一个版本。', renderer: 'framework_update' },
];

export const coreAdminPage = (pathname) => CORE_ADMIN_PAGES.find((page) => page.path === pathname) ?? null;
