/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/access.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import os from 'node:os';

/** Classify interfaces so a reachable LAN address is preferred over a private tunnel or loopback. */
export function classifyInterface(name) {
  if (/^(wlan|wl|eth|en|rndis|ap|swlan)/i.test(name)) return 'lan';
  if (/^(tun|tap|ppp|wg|ts|tailscale|zt)/i.test(name)) return 'tunnel';
  if (/^(lo)/i.test(name)) return 'loopback';
  return 'other';
}

const RANK = { lan: 0, other: 1, tunnel: 2, loopback: 3 };

export function listAddresses({ port = 8980 } = {}) {
  const out = [];
  let ifaces;
  try { ifaces = os.networkInterfaces(); } catch { return out; }
  for (const [name, addrs] of Object.entries(ifaces ?? {})) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const kind = classifyInterface(name);
      out.push({
        interface: name,
        ip: a.address,
        kind,
        internal: Boolean(a.internal),
        admin_url: `http://${a.address}:${port}/admin`,
      });
    }
  }
  // Prefer LAN addresses because they are usually the useful user-facing entry points.
  out.sort((x, y) => (RANK[x.kind] - RANK[y.kind]) || x.interface.localeCompare(y.interface));
  return out;
}

export function accessInfo({ device, version, deployId, bind = '0.0.0.0', port = 8980, health = 'ok' } = {}) {
  const addresses = listAddresses({ port });
  const lan = addresses.filter((a) => a.kind === 'lan');
  return {
    device: device || 'unknown',
    framework_version: version || 'unknown',
    git_commit: deployId || 'unknown',
    bind,
    port,
    // bind 是不是 0.0.0.0 決定了「別的設備能不能連」——這是判斷，不是猜測
    lan_reachable: bind === '0.0.0.0' || bind === '::',
    addresses,
    // 首頁與 deploy 輸出用哪一個：LAN 有就用 LAN；沒有就別假裝有
    primary: lan[0] ?? addresses.find((a) => a.kind !== 'loopback') ?? null,
    health,
  };
}

// ============================================================
// 自檢：node src/system/access.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
if (process.argv.includes('--self-test')
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

  t('wlan0 是 LAN（哥連 Wi-Fi 要用的）', classifyInterface('wlan0') === 'lan');
  t('eth0/en0 是 LAN', classifyInterface('eth0') === 'lan' && classifyInterface('en0') === 'lan');
  t('tun0 是 tunnel（只有開發機走得通，不能給哥）', classifyInterface('tun0') === 'tunnel');
  t('wg0/tailscale0 是 tunnel', classifyInterface('wg0') === 'tunnel' && classifyInterface('tailscale0') === 'tunnel');
  t('lo 是 loopback', classifyInterface('lo') === 'loopback');

  const info = accessInfo({ device: 'x', version: '0.1.0', deployId: 'abc1234', port: 8980 });
  t('每個地址都有可直接點開的 admin URL',
    info.addresses.every((a) => a.admin_url.startsWith('http://') && a.admin_url.endsWith(':8980/admin')));
  t('地址排序把 LAN 排在 tunnel/loopback 之前', (() => {
    const ranks = info.addresses.map((a) => RANK[a.kind]);
    return ranks.every((v, i) => i === 0 || ranks[i - 1] <= v);
  })());
  t('0.0.0.0 綁定 → lan_reachable=true', accessInfo({ bind: '0.0.0.0' }).lan_reachable === true);
  t('只綁 127.0.0.1 → lan_reachable=false（別的設備連不上，要說清楚）',
    accessInfo({ bind: '127.0.0.1' }).lan_reachable === false);
  t('缺失欄位一律 unknown，不編造', (() => {
    const i = accessInfo({});
    return i.device === 'unknown' && i.framework_version === 'unknown' && i.git_commit === 'unknown';
  })());
  t('primary 永不指向 loopback（那個網址對哥沒用）',
    info.primary === null || info.primary.kind !== 'loopback');
  t('沒有 IPv4 時 primary=null 而不是瞎編一個',
    accessInfo({ device: 'x' }).addresses.length === 0 ? accessInfo({ device: 'x' }).primary === null : true);

  process.exit(fails ? 1 : 0);
}
