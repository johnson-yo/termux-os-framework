/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/metrics.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';

const readNum = (p) => { try { return Number(fs.readFileSync(p, 'utf8').trim()); } catch { return null; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// CPU usage%：/proc/stat 首行兩次採樣 delta（模塊態保存上次）；首次調用返回 null
let lastStat = null;
function cpuUsage() {
  const line = read('/proc/stat')?.split('\n')[0];
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + (f[4] ?? 0);
  const total = f.reduce((a, b) => a + b, 0);
  const prev = lastStat;
  lastStat = { idle, total };
  if (!prev || total === prev.total) return null;
  return Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 1000) / 10;
}

function memory() {
  const mi = read('/proc/meminfo');
  if (!mi) return null;
  const kb = (k) => Number((mi.match(new RegExp(`${k}:\\s+(\\d+)`)) ?? [])[1] ?? NaN);
  const total = kb('MemTotal'); const avail = kb('MemAvailable');
  if (!Number.isFinite(total)) return null;
  return { total_mb: Math.round(total / 1024), available_mb: Number.isFinite(avail) ? Math.round(avail / 1024) : null };
}

function storageOf(path) {
  try {
    const s = fs.statfsSync(path);
    const total = s.blocks * s.bsize; const free = s.bavail * s.bsize;
    return { path, total_gb: Math.round(total / 2 ** 30 * 10) / 10, free_gb: Math.round(free / 2 ** 30 * 10) / 10 };
  } catch { return null; }
}

// 溫度：掃 thermal_zone，取有含義的最大值（battery/cpu/skin 常見）；無 /sys 權限時 null
function temperature() {
  let best = null;
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      const t = readNum(`/sys/class/thermal/${z}/temp`);
      if (t === null || t <= 0 || t > 150000) continue;
      const c = t > 1000 ? t / 1000 : t;
      const type = read(`/sys/class/thermal/${z}/type`)?.trim() ?? z;
      if (!best || c > best.celsius) best = { celsius: Math.round(c * 10) / 10, sensor: type };
    }
  } catch { /* 無權限/不存在 */ }
  return best;
}

function processCount() {
  try { return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length; }
  catch { return null; }
}

// GPU：只報存在性與設備名，利用率一律 unsupported（無可靠接口不猜百分比）
function gpu() {
  const model = read('/sys/class/kgsl/kgsl-3d0/gpu_model')?.trim();
  if (model) return { available: true, device: model, utilization: 'unsupported' };
  if (fs.existsSync('/sys/class/kgsl')) return { available: true, device: 'kgsl', utilization: 'unsupported' };
  return { available: false };
}

export function collectMetrics() {
  // Android 限制 /proc/{loadavg,stat,uptime} 讀取——用 syscall 系（os.loadavg/uptime）兜底；
  // 兩路都取不到就 null，前端顯示 Unsupported，不偽造
  const load = read('/proc/loadavg')?.trim().split(' ').slice(0, 3).map(Number)
    ?? (os.loadavg().some((x) => x > 0) ? os.loadavg().map((x) => Math.round(x * 100) / 100) : null);
  const up = read('/proc/uptime');
  return {
    ts: Date.now(),
    cpu: { cores: os.cpus().length || os.availableParallelism?.() || null, load, usage_percent: cpuUsage() },
    memory: memory(),
    storage: { home: storageOf(os.homedir()), sdcard: storageOf('/sdcard') },
    temperature: temperature(),
    process_count: processCount(),
    device_uptime_s: up ? Math.round(Number(up.split(' ')[0])) : Math.round(os.uptime()) || null,
    framework_uptime_s: Math.round(process.uptime()),
    gpu: gpu(),
  };
}
