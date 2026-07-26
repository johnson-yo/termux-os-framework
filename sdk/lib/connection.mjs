/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/lib/connection.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emit, fail, runCapture } from './util.mjs';

export const SDK_HOME = process.env.TERMUX_OS_SDK_HOME
  || path.join(os.homedir(), '.termux-os-sdk');
export const CONNECTIONS_DIR = path.join(SDK_HOME, 'connections');

const DEFAULT_LOCAL_URL = process.env.TERMUX_OS_FRAMEWORK_URL || 'http://127.0.0.1:8980';
const TRANSPORT_TYPES = ['local', 'adb', 'ssh', 'custom', 'none'];

// Connection profiles default to the local runtime; SSH is one optional transport.
export function listConnections() {
  let names = [];
  try { names = fs.readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith('.json')); } catch { /* No directory means no profiles. */ }
  return names.map((f) => f.replace(/\.json$/, ''));
}

function loadProfile(name, flags) {
  const file = path.join(CONNECTIONS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    const avail = listConnections();
    return fail(flags, 'connection_not_found', file,
      avail.length
        ? `Available connections: ${avail.join(', ')}. Or create ${file} with schema termux-os.connection.v1.`
        : `No connection profile exists. Create ${file}; see sdk/CONNECTIONS.md.`);
  }
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fail(flags, 'connection_invalid', `${file}: ${String(e?.message ?? e)}`, 'Fix the JSON and retry.'); }
  if (p.schema !== 'termux-os.connection.v1') {
    return fail(flags, 'connection_invalid', `${file}: schema must be termux-os.connection.v1`, 'See sdk/CONNECTIONS.md.');
  }
  const type = p.transport?.type ?? 'none';
  if (!TRANSPORT_TYPES.includes(type)) {
    return fail(flags, 'connection_invalid', `${file}: transport.type "${type}" is not one of ${TRANSPORT_TYPES.join('/')}`, 'Fix the profile and retry.');
  }
  if (!p.framework_url && type !== 'ssh') {
    return fail(flags, 'connection_invalid', `${file}: framework_url is required except for the SSH fallback`, 'Add framework_url.');
  }
  return { name, framework_url: p.framework_url ?? null, transport: { type, ...p.transport }, source: 'profile' };
}

/**
 * Resolve explicit URL, named profile, SSH compatibility alias, or local default.
 */
export function resolveConnection(flags) {
  if (flags['framework-url']) {
    return { name: null, framework_url: String(flags['framework-url']).replace(/\/$/, ''),
      transport: { type: 'none' }, source: 'url-only' };
  }
  if (flags.connection) return loadProfile(String(flags.connection), flags);
  if (flags.remote) {
    return { name: null, framework_url: null,
      transport: { type: 'ssh', host: String(flags.remote) }, source: 'remote-alias' };
  }
  return { name: 'local', framework_url: DEFAULT_LOCAL_URL, transport: { type: 'local' }, source: 'default-local' };
}

// HTTP observes Framework state; SSH curl is a compatibility fallback.
export async function frameworkFetch(conn, urlPath, { timeoutMs = 5000, token = null } = {}) {
  if (conn.framework_url) {
    try {
      const r = await fetch(`${conn.framework_url}${urlPath}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return { ok: true, status: r.status, data: await r.json().catch(() => null) };
    } catch (e) {
      return { ok: false, error: `framework unreachable at ${conn.framework_url}: ${String(e?.cause?.code ?? e?.message ?? e)}` };
    }
  }
  if (conn.transport.type === 'ssh') {
    const auth = token ? `-H 'Authorization: Bearer ${token}' ` : '';
    const r = runCapture('ssh', [conn.transport.host, `curl -s -m ${Math.ceil(timeoutMs / 1000)} ${auth}http://127.0.0.1:8980${urlPath}`]);
    if (r.status !== 0 || !r.stdout.trim()) return { ok: false, error: `ssh ${conn.transport.host} unreachable or framework down` };
    try { return { ok: true, status: 200, data: JSON.parse(r.stdout) }; }
    catch { return { ok: false, error: 'framework returned non-JSON via ssh tunnel' }; }
  }
  return { ok: false, error: 'connection has no framework_url and no ssh fallback' };
}

// Transport is used only for file transfer and target-side commands.
export function transportPut(conn, localPath, remoteDest, flags) {
  const t = conn.transport;
  if (t.type === 'local') {
    const dest = remoteDest.replace(/^~\//, `${os.homedir()}/`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localPath, dest);
    return 0;
  }
  if (t.type === 'ssh') return spawnSync('scp', [localPath, `${t.host}:${remoteDest}`], { stdio: 'inherit' }).status ?? 1;
  if (t.type === 'adb') return spawnSync('adb', [...(t.serial ? ['-s', t.serial] : []), 'push', localPath, remoteDest], { stdio: 'inherit' }).status ?? 1;
  if (t.type === 'custom' && t.put) {
    return spawnSync('bash', ['-c', t.put.replaceAll('{src}', localPath).replaceAll('{dest}', remoteDest)], { stdio: 'inherit' }).status ?? 1;
  }
  return fail(flags, 'transport_unavailable',
    `connection "${conn.name ?? conn.source}" transport=${t.type} cannot transfer files`,
    'Use a connection with local, ssh, or adb transport for file operations.');
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const withRemoteEnv = (command, env) => {
  const entries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined && value !== null);
  return entries.length
    ? `env ${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')} ${command}`
    : command;
};

export function transportExec(conn, command, flags, { capture = false, env = {} } = {}) {
  const t = conn.transport;
  const opts = capture ? { encoding: 'utf8' } : { stdio: 'inherit' };
  const norm = (r) => (capture ? { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } : (r.status ?? 1));
  if (t.type === 'local') {
    return norm(spawnSync('bash', ['-c', command], { ...opts, env: { ...process.env, ...env } }));
  }
  const targetCommand = withRemoteEnv(command, env);
  if (t.type === 'ssh') return norm(spawnSync('ssh', [t.host, targetCommand], opts));
  if (t.type === 'adb') return norm(spawnSync('adb', [...(t.serial ? ['-s', t.serial] : []), 'shell', targetCommand], opts));
  if (t.type === 'custom' && t.exec) {
    return norm(spawnSync('bash', ['-c', t.exec.replaceAll('{cmd}', targetCommand)], opts));
  }
  return fail(flags, 'transport_unavailable',
    `connection "${conn.name ?? conn.source}" transport=${t.type} cannot execute commands`,
    'Use a connection with local, ssh, or adb transport for shell operations.');
}

// Report browser URLs without claiming that a tunnel or forwarding rule exists.
export async function cmdAccess(flags, pos) {
  const conn = resolveConnection(flags);
  const pkgId = pos[0] ?? null;
  const info = await frameworkFetch(conn, '/api/access-info');
  const reachable = info.ok && info.data?.ok === true;

  // Prefer the profile URL; an SSH-only profile may use the reported LAN address.
  let base = conn.framework_url;
  const addresses = reachable ? (info.data.addresses ?? []) : [];
  if (!base) base = addresses.find((a) => a.kind === 'lan')?.admin_url?.replace(/\/admin$/, '') ?? null;

  const lan = addresses.find((a) => a.kind === 'lan')?.admin_url?.replace(/\/admin$/, '') ?? null;
  const out = {
    ok: true, connection: conn.name ?? conn.source, transport: conn.transport.type,
    reachable,
    ...(reachable ? { device: info.data.device ?? null, build: info.data.git_commit ?? info.data.deploy_id ?? null } : { error: info.ok ? 'framework responded abnormally' : info.error }),
    framework: base ? `${base}/admin` : null,
    ...(pkgId ? { package: base ? `${base}/packages/${pkgId}/` : null } : {}),
    ...(lan && lan !== base ? { lan: pkgId ? `${lan}/packages/${pkgId}/` : `${lan}/admin` } : {}),
  };
  emit(out, flags, (o) => {
    console.log(`Connection: ${o.connection} (transport: ${o.transport})`);
    if (!o.reachable) console.log(`⚠ Framework is unreachable: ${o.error}\nURLs remain listed for use after Framework starts.`);
    else console.log(`Device: ${o.device}  Build: ${o.build}`);
    if (o.framework) console.log(`\nFramework:\n${o.framework}`);
    if (o.package) console.log(`\nPackage:\n${o.package}`);
    if (o.lan) console.log(`\nLAN:\n${o.lan}`);
    if (o.transport === 'local') console.log('\nOpen with:\nAndroid Browser on this device');
  });
  if (!base) process.exit(1);
}
