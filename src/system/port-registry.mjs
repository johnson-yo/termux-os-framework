/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package port declarations and Framework port policy.
 * [OUTPUT]: Stable package-owned HTTP port assignments and an authenticated admin snapshot.
 * [POS]: src/system/port-registry.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT_SCHEMA = 'termux-os-framework.ports.v1';
const PORT_VISIBILITY = new Set(['loopback', 'lan']);

let config = {
  file: null,
  start: 9000,
  end: 9999,
  reserved: new Set([8796, 8797, 8980]),
};
let state = { schema: PORT_SCHEMA, assignments: {}, updated_at: null };

const clone = (value) => JSON.parse(JSON.stringify(value));

function readState() {
  if (!config.file) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(config.file, 'utf8'));
    if (parsed?.schema === PORT_SCHEMA && parsed.assignments && typeof parsed.assignments === 'object') {
      state = { schema: PORT_SCHEMA, assignments: parsed.assignments, updated_at: parsed.updated_at ?? null };
    }
  } catch { /* A missing or corrupt registry is rebuilt from package manifests. */ }
}

function writeState() {
  if (!config.file) return;
  fs.mkdirSync(path.dirname(config.file), { recursive: true, mode: 0o700 });
  const tmp = `${config.file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  const next = { ...state, updated_at: new Date().toISOString() };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, config.file);
    fs.chmodSync(config.file, 0o600);
    state = next;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function configurePortRegistry(opts = {}) {
  const start = Number(opts.start) || 9000;
  const end = Number(opts.end) || 9999;
  config = {
    file: opts.path ? path.resolve(opts.path) : null,
    start: Math.max(1024, Math.min(start, end)),
    end: Math.min(65535, Math.max(start, end)),
    reserved: new Set([...(opts.reserved ?? []), Number(opts.corePort) || 8980].filter(Number.isInteger)),
  };
  state = { schema: PORT_SCHEMA, assignments: {}, updated_at: null };
  readState();
  return portRegistrySnapshot();
}

const packagePortKey = (packageId, portId) => `${packageId}:${portId}`;
const allAssignments = () => Object.values(state.assignments).flatMap((items) => items ?? []);
const usedByOther = (port, packageId, portId) => {
  if (config.reserved.has(port)) return 'framework';
  const owner = allAssignments().find((item) => item.port === port
    && (item.package_id !== packageId || item.id !== portId));
  return owner?.package_id ?? null;
};

function nextAvailable(packageId, portId, planned = []) {
  for (let port = config.start; port <= config.end; port++) {
    if (!usedByOther(port, packageId, portId) && !planned.some((item) => item.port === port)) return port;
  }
  const error = new Error(`no package port available for ${packageId}:${portId}`);
  error.code = 'package_port_exhausted';
  throw error;
}

function planPackagePorts(packageId, declarations = []) {
  const previous = new Map((state.assignments[packageId] ?? []).map((item) => [item.id, item]));
  const assigned = [];
  for (const declaration of declarations ?? []) {
    const prior = previous.get(declaration.id);
    const requested = Number(declaration.preferred ?? 0);
    if (requested && (requested < config.start || requested > config.end)) {
      const error = new Error(`preferred port ${requested} for ${packageId}:${declaration.id} is outside ${config.start}-${config.end}`);
      error.code = 'package_port_out_of_range';
      throw error;
    }
    const port = prior?.port ?? (requested || nextAvailable(packageId, declaration.id, assigned));
    const conflict = usedByOther(port, packageId, declaration.id)
      || assigned.find((item) => item.port === port)?.stable_key;
    if (conflict) {
      const error = new Error(`package port ${port} for ${packageId}:${declaration.id} conflicts with ${conflict}`);
      error.code = 'package_port_conflict';
      throw error;
    }
    assigned.push({
      package_id: packageId,
      id: declaration.id,
      port,
      protocol: declaration.protocol,
      visibility: prior?.visibility ?? declaration.visibility ?? 'loopback',
      health: declaration.health ?? null,
      source: prior?.source ?? (requested ? 'manifest' : 'allocated'),
      stable_key: packagePortKey(packageId, declaration.id),
    });
  }
  return assigned;
}

export function registerPackagePorts(packageId, declarations = []) {
  const assigned = planPackagePorts(packageId, declarations);
  state.assignments[packageId] = assigned;
  writeState();
  return clone(assigned);
}

export function checkPackagePorts(packageId, declarations = []) {
  try {
    return { ok: true, ports: clone(planPackagePorts(packageId, declarations)) };
  } catch (error) {
    return { ok: false, error: error.code ?? 'package_port_invalid', detail: String(error.message ?? error) };
  }
}

export function getPackagePorts(packageId) {
  return clone(state.assignments[packageId] ?? []);
}

/**
 * Apply the editable fields exposed by Admin Package Setting. The update is
 * validated as one transaction so a collision cannot leave half a Package
 * configuration written to the private registry.
 */
export function updatePackagePortSettings(packageId, updates = []) {
  const current = state.assignments[packageId] ?? [];
  if (!current.length) {
    const error = new Error(`Package ${packageId} has no assigned ports`);
    error.code = 'package_has_no_ports';
    throw error;
  }
  const list = Array.isArray(updates)
    ? updates
    : Object.entries(updates ?? {}).map(([id, value]) => ({ id, ...value }));
  const byId = new Map(current.map((item) => [item.id, item]));
  if (list.some((item) => !item || typeof item.id !== 'string' || !byId.has(item.id))) {
    const error = new Error(`unknown port for Package ${packageId}`);
    error.code = 'unknown_package_port';
    throw error;
  }
  const patches = new Map(list.map((item) => [item.id, item]));
  const planned = [];
  for (const item of current) {
    const patch = patches.get(item.id) ?? {};
    const port = patch.port === undefined ? item.port : Number(patch.port);
    const visibility = patch.visibility === undefined ? item.visibility : patch.visibility;
    if (!Number.isInteger(port) || port < config.start || port > config.end) {
      const error = new Error(`Package port ${port} for ${packageId}:${item.id} is outside ${config.start}-${config.end}`);
      error.code = 'package_port_out_of_range';
      throw error;
    }
    if (!PORT_VISIBILITY.has(visibility)) {
      const error = new Error(`Package port visibility must be one of [${[...PORT_VISIBILITY].join(', ')}]`);
      error.code = 'package_port_visibility_invalid';
      throw error;
    }
    const externalOwner = allAssignments().find((other) => other.package_id !== packageId && other.port === port);
    const samePackageOwner = planned.find((other) => other.port === port);
    if (externalOwner || samePackageOwner) {
      const error = new Error(`package port ${port} for ${packageId}:${item.id} conflicts with `
        + (externalOwner?.package_id ?? samePackageOwner?.stable_key));
      error.code = 'package_port_conflict';
      throw error;
    }
    planned.push({
      ...item,
      port,
      visibility,
      source: patch.port === undefined ? item.source : 'admin',
    });
  }
  state.assignments[packageId] = planned;
  writeState();
  return clone(planned);
}

export function releasePackagePorts(packageId) {
  const existed = Object.hasOwn(state.assignments, packageId);
  delete state.assignments[packageId];
  if (existed) writeState();
  return existed;
}

export function prunePackagePorts(packageIds = []) {
  const keep = new Set(packageIds);
  let changed = false;
  for (const id of Object.keys(state.assignments)) {
    if (!keep.has(id)) { delete state.assignments[id]; changed = true; }
  }
  if (changed) writeState();
  return changed;
}

export function listPackagePorts() {
  return clone(allAssignments()).sort((a, b) => a.port - b.port || a.package_id.localeCompare(b.package_id));
}

export function portRegistrySnapshot() {
  return {
    schema: PORT_SCHEMA,
    policy: {
      range: { start: config.start, end: config.end },
      reserved: [...config.reserved].sort((a, b) => a - b),
      default_visibility: 'loopback',
      editable: true,
      rule: 'Every declared HTTP API port belongs to exactly one Package; Core-reserved ports cannot be claimed.',
    },
    ports: listPackagePorts(),
    updated_at: state.updated_at,
  };
}

if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'framework-ports-'));
  let fails = 0;
  const t = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fails++; };
  configurePortRegistry({ path: path.join(tmp, 'ports.json'), corePort: 8980, start: 9000, end: 9003 });
  const first = registerPackagePorts('github.example.service.demo', [
    { id: 'http', protocol: 'http', preferred: 9001, visibility: 'loopback', health: '/health' },
  ]);
  t('preferred package port is assigned', first[0].port === 9001);
  t('assignment survives registry reload', configurePortRegistry({ path: path.join(tmp, 'ports.json'), corePort: 8980, start: 9000, end: 9003 }).ports[0].port === 9001);
  const edited = updatePackagePortSettings('github.example.service.demo', [{ id: 'http', port: 9002, visibility: 'lan' }]);
  t('admin can edit port and visibility atomically', edited[0].port === 9002 && edited[0].visibility === 'lan');
  t('edited assignment survives registry reload', configurePortRegistry({ path: path.join(tmp, 'ports.json'), corePort: 8980, start: 9000, end: 9003 }).ports[0].visibility === 'lan');
  let conflict = false;
  try { registerPackagePorts('github.example.service.other', [{ id: 'http', protocol: 'http', preferred: 9002 }]); }
  catch (e) { conflict = e.code === 'package_port_conflict'; }
  t('conflicting preferred port is rejected', conflict);
  const dynamic = registerPackagePorts('github.example.service.dynamic', [
    { id: 'api', protocol: 'http' }, { id: 'metrics', protocol: 'http' },
  ]);
  t('dynamic declarations receive distinct ports', dynamic[0].port !== dynamic[1].port);
  let range = false;
  try { registerPackagePorts('github.example.service.range', [{ id: 'http', protocol: 'http', preferred: 9010 }]); }
  catch (e) { range = e.code === 'package_port_out_of_range'; }
  t('preferred port outside policy range is rejected', range);
  releasePackagePorts('github.example.service.dynamic');
  t('package port release works', releasePackagePorts('github.example.service.demo') && listPackagePorts().length === 0);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
