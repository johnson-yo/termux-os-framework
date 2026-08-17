/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A private Framework connection profile, Package ID, and local mount path.
 * [OUTPUT]: An SSHFS view of the one reconciled active Package worktree.
 * [POS]: sdk/lib/dev-mount.mjs in termux-os-framework.
 * [PROTOCOL]: Resolve active truth through Framework before every mount; never create
 *             a Package, worktree, runtime owner, or shadow data root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emit, fail, frameworkToken } from './util.mjs';
import { frameworkFetch, resolveConnection } from './connection.mjs';

const TOKEN = frameworkToken();
const ACTIONS = new Set(['mount', 'status', 'unmount', 'remount']);
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/;
const DEFAULT_OPTIONS = [
  'reconnect',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=3',
  'cache=no',
  'attr_timeout=0',
  'entry_timeout=0',
  'negative_timeout=0',
];
const USAGE = [
  'Usage:',
  '  termux-os-sdk dev-mount mount   <connection> <package-id> <local-mount>',
  '  termux-os-sdk dev-mount status  <connection> <package-id> <local-mount>',
  '  termux-os-sdk dev-mount remount <connection> <package-id> <local-mount>',
  '  termux-os-sdk dev-mount unmount <connection> <package-id> <local-mount>',
  '',
  'The connection profile supplies the SSH host from the existing SSH configuration.',
].join('\n');

const commandPath = (name) => {
  const override = name === 'sshfs' ? process.env.TERMUX_OS_SSHFS_BIN : null;
  if (override) {
    try {
      fs.accessSync(override, fs.constants.X_OK);
      return override;
    } catch { /* Fall through to PATH. */ }
  }
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
};

const runCapture = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

export function validPackageId(id) {
  return typeof id === 'string' && PACKAGE_ID.test(id);
}

export function validMountPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.trim() !== value) return false;
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || resolved.includes('\0')) return false;
  return !/[\r\n]/.test(resolved);
}

function activePathFor(reconcile) {
  const active = reconcile?.active;
  if (!active?.path || !active.root || !active.version || active.exists !== true
    || /[\\/]/.test(active.version)) return null;
  const expected = path.posix.join(active.root, 'versions', active.version);
  return active.path === expected ? active.path : null;
}

function configuredSshHost(connection) {
  const transport = connection?.transport ?? {};
  const value = transport.type === 'ssh'
    ? transport.host
    : (transport.ssh_host ?? transport.host ?? null);
  if (typeof value !== 'string' || !HOST_NAME.test(value)) return null;
  return value;
}

function mountInfo(localMount) {
  const findmnt = commandPath('findmnt');
  if (findmnt) {
    const result = runCapture(findmnt, ['-M', localMount, '-n', '-o', 'SOURCE,FSTYPE,OPTIONS']);
    if (result.status === 0 && result.stdout.trim()) {
      const fields = result.stdout.trim().split(/\s+/);
      return {
        source: fields[0] ?? null,
        fstype: fields[1] ?? null,
        options: fields.slice(2).join(' '),
        raw: result.stdout.trim(),
      };
    }
    return null;
  }
  const mountpoint = commandPath('mountpoint');
  if (!mountpoint || runCapture(mountpoint, ['-q', localMount]).status !== 0) return null;
  const mounts = runCapture('mount', []);
  const line = mounts.stdout.split('\n').find((item) => item.includes(` on ${localMount} `));
  if (!line) return { source: null, fstype: null, options: null, raw: null };
  const match = line.match(/^(.+?) on .+ type (\S+) \((.*)\)$/);
  return match
    ? { source: match[1], fstype: match[2], options: match[3], raw: line }
    : { source: null, fstype: null, options: null, raw: line };
}

export function isSshfsMount(info) {
  return Boolean(info?.fstype && /^fuse\.sshfs/.test(info.fstype));
}

function sourceMatches(info, host, remotePath) {
  if (!isSshfsMount(info) || typeof info.source !== 'string') return false;
  const suffix = `:${remotePath}`;
  if (!info.source.endsWith(suffix)) return false;
  const sourceHost = info.source.slice(0, -suffix.length);
  return sourceHost === host || sourceHost.endsWith(`@${host}`);
}

function ensureLocalDirectory(localMount) {
  const resolved = path.resolve(localMount);
  let stat = null;
  try { stat = fs.lstatSync(resolved); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!stat) {
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  if (stat.isSymbolicLink()) throw new Error(`local mount path must not be a symlink: ${resolved}`);
  if (!stat.isDirectory()) throw new Error(`local mount path is not a directory: ${resolved}`);
  if (mountInfo(resolved)) return resolved;
  if (fs.readdirSync(resolved).length > 0) {
    throw new Error(`local mount directory is not empty: ${resolved}`);
  }
  return resolved;
}

function targetError(code, detail, fix = null) {
  return { ok: false, code, detail, ...(fix ? { fix } : {}) };
}

async function readTarget(connection, packageId) {
  const encoded = encodeURIComponent(packageId);
  const response = await frameworkFetch(connection, `/api/dev/packages/${encoded}/status`, { token: TOKEN });
  if (!response.ok) return targetError('framework_unreachable', response.error, 'Start Framework and retry.');
  if (response.status >= 400 || !response.data?.ok) {
    const error = response.data?.error ?? (response.status === 401 ? 'unauthorized' : 'reconcile_failed');
    return targetError(error, response.data?.detail ?? response.data?.reconcile ?? response.status,
      response.data?.fix ?? 'Resolve Framework state and retry.');
  }

  const data = response.data;
  const reconcile = data.reconcile;
  if (!reconcile || reconcile.conflict || reconcile.safe_for_write !== true) {
    return targetError('package_reconcile_required', reconcile?.conflicts ?? reconcile,
      'Resolve the reported duplicate, stale, or legacy identity before mounting.');
  }
  const remotePath = activePathFor(reconcile);
  if (!remotePath) {
    return targetError('unsafe_active_path', reconcile.active,
      'Framework must report the installed active versions/<version> worktree.');
  }
  if (reconcile.legacy_workspaces?.length) {
    return targetError('legacy_workspace_present', reconcile.legacy_workspaces,
      'Archive the legacy workspace before mounting.');
  }
  if (reconcile.previous?.path === remotePath || reconcile.rollback?.path === remotePath) {
    return targetError('rollback_path_selected', remotePath,
      'The active path must not be previous or rollback material.');
  }
  if (data.watching !== true || reconcile.watcher?.watching !== true) {
    return targetError('watcher_not_running', reconcile.watcher,
      `Start the watcher with: termux-os-sdk dev start ${packageId}`);
  }
  if (data.status !== 'loaded' || data.error) {
    return targetError('package_unhealthy', { status: data.status, error: data.error },
      'Restore the Package service health before mounting.');
  }
  if (!reconcile.runtime_owner?.pid || !reconcile.runtime_owner?.generation) {
    return targetError('runtime_owner_missing', reconcile.runtime_owner,
      'Reload the active Package and confirm it has exactly one runtime owner.');
  }
  const staleExecutableGenerations = (reconcile.stale_generations ?? [])
    .filter((item) => !String(item.id ?? '').endsWith('.config'));
  if (staleExecutableGenerations.length) {
    return targetError('stale_runtime_generation', staleExecutableGenerations,
      'Reload the Package until only the current runtime generation remains.');
  }

  const services = Array.isArray(data.services) ? data.services : [];
  let serviceStates = [];
  if (services.length) {
    const stage = await frameworkFetch(connection, '/api/stage/services', { token: TOKEN });
    if (!stage.ok || stage.status >= 400 || !stage.data?.ok) {
      return targetError('service_status_unavailable', stage.error ?? stage.data,
        'Query Framework Stage service health and retry.');
    }
    const byId = new Map((stage.data.services ?? []).map((item) => [item.id, item]));
    serviceStates = services.map((id) => byId.get(id) ?? { id, missing: true });
    const unhealthy = serviceStates.filter((item) => item.missing
      || item.process?.state !== 'running' || item.health?.state !== 'healthy');
    if (unhealthy.length) {
      return targetError('service_unhealthy', unhealthy,
        'Wait for the Package service to be running and healthy before mounting.');
    }
  }

  return {
    ok: true,
    package_id: packageId,
    state: data.state,
    state_summary: data.state_summary,
    watching: data.watching,
    watcher: reconcile.watcher,
    runtime_owner: reconcile.runtime_owner,
    service_states: serviceStates,
    active: reconcile.active,
    remote_path: remotePath,
    reconcile,
  };
}

function targetResult(snapshot, connection, localMount, info, host) {
  const mounted = Boolean(info);
  const matches = mounted && sourceMatches(info, host, snapshot.remote_path);
  const manifestVisible = mounted
    ? fs.existsSync(path.join(localMount, 'termux-os.package.json'))
    : false;
  return {
    ok: true,
    package_id: snapshot.package_id,
    connection: connection.name ?? connection.source,
    mountpoint: localMount,
    mounted,
    sshfs: isSshfsMount(info),
    filesystem: info,
    remote_path: snapshot.remote_path,
    remote_path_matches: matches,
    package_manifest_visible: manifestVisible,
    state: snapshot.state,
    state_summary: snapshot.state_summary,
    watching: snapshot.watching,
    runtime_owner: snapshot.runtime_owner,
    service_states: snapshot.service_states,
  };
}

function unmountLocal(localMount) {
  const info = mountInfo(localMount);
  if (!info) return { ok: true, changed: false, mounted: false, filesystem: null };
  if (!isSshfsMount(info)) {
    return targetError('mountpoint_occupied', info,
      'Only an SSHFS mount created by dev-mount may be unmounted by this command.');
  }
  const binary = commandPath('fusermount3') ?? commandPath('fusermount');
  if (!binary) return targetError('fusermount_missing', null, 'Install FUSE userspace tools and retry.');
  let result = runCapture(binary, ['-u', localMount]);
  if (result.status !== 0) result = runCapture(binary, ['-u', '-z', localMount]);
  if (result.status !== 0 || mountInfo(localMount)) {
    return targetError('unmount_failed', result.stderr || result.stdout || result.status,
      'Retry unmount after the SSH connection recovers; do not delete the mount directory.');
  }
  return { ok: true, changed: true, mounted: false, filesystem: info };
}

function mountLocal(localMount, host, remotePath) {
  const sshfs = commandPath('sshfs');
  if (!sshfs) return targetError('sshfs_missing', null,
    'Install sshfs in the host user environment, then retry.');
  const existing = mountInfo(localMount);
  if (existing) {
    if (sourceMatches(existing, host, remotePath)) {
      return { ok: true, changed: false, already: true, filesystem: existing };
    }
    return targetError(isSshfsMount(existing) ? 'mount_target_mismatch' : 'mountpoint_occupied', existing,
      'Use dev-mount remount only for an existing SSHFS mount, or choose an empty directory.');
  }
  const args = [`${host}:${remotePath}`, localMount, ...DEFAULT_OPTIONS.flatMap((option) => ['-o', option])];
  const result = runCapture(sshfs, args);
  if (result.status !== 0) {
    return targetError('sshfs_mount_failed', result.stderr || result.stdout || result.status,
      'Check the existing SSH configuration and target connectivity.');
  }
  const mounted = mountInfo(localMount);
  if (!mounted || !sourceMatches(mounted, host, remotePath)) {
    return targetError('sshfs_mount_unverified', mounted,
      'The command returned without a verified SSHFS mount; inspect the mountpoint before retrying.');
  }
  return { ok: true, changed: true, already: false, filesystem: mounted };
}

function parseInvocation(flags, pos) {
  const action = pos[0];
  if (!ACTIONS.has(action)) return { error: `unknown action: ${action ?? '(missing)'}` };
  let connectionName = flags.connection ?? flags.device ?? null;
  let packageId = flags.package ?? null;
  let localMount = flags.mount ?? null;
  if (pos.length === 4) [connectionName, packageId, localMount] = pos.slice(1);
  else if (pos.length === 3 && connectionName) [packageId, localMount] = pos.slice(1);
  else if (pos.length === 3 && (flags.remote || flags['framework-url'])) {
    [packageId, localMount] = pos.slice(1);
  }
  if (!connectionName || !packageId || !localMount) {
    return { error: USAGE };
  }
  return { action, connectionName, packageId, localMount };
}

export async function cmdDevMount(flags, pos) {
  const invocation = parseInvocation(flags, pos);
  if (invocation.error) return fail(flags, 'invalid_dev_mount_arguments', invocation.error, USAGE);
  const { action, connectionName, packageId, localMount: rawMount } = invocation;
  if (!validPackageId(packageId)) return fail(flags, 'invalid_package_id', packageId, 'Use the exact installed Package ID.');
  if (!validMountPath(rawMount)) return fail(flags, 'invalid_mount_path', rawMount, 'Use a non-root absolute local directory without control characters.');

  let connection;
  try {
    connection = resolveConnection({ ...flags, connection: connectionName });
  } catch (error) {
    return fail(flags, 'connection_invalid', String(error?.message ?? error), 'Fix the private connection profile and retry.');
  }
  const localMount = path.resolve(rawMount);

  if (action === 'unmount') {
    const result = unmountLocal(localMount);
    if (!result.ok) return fail(flags, result.code, result.detail, result.fix);
    return emit({
      ok: true, action, package_id: packageId, connection: connection.name ?? connection.source,
      mountpoint: localMount, ...result,
    }, flags, (output) => {
      console.log(output.changed ? '✓ SSHFS mount removed.' : '✓ Mountpoint was already unmounted.');
      console.log(`  Mountpoint: ${output.mountpoint}`);
    });
  }

  const host = configuredSshHost(connection);
  if (!host) return fail(flags, 'sshfs_host_missing', connectionName,
    'Add the existing SSH host to the private connection profile as transport.ssh_host, or use an SSH transport profile.');
  const snapshot = await readTarget(connection, packageId);
  if (!snapshot.ok) return fail(flags, snapshot.code, snapshot.detail, snapshot.fix);
  if (action === 'status') {
    const info = mountInfo(localMount);
    return emit(targetResult(snapshot, connection, localMount, info, host), flags, (output) => {
      console.log(`Package: ${output.package_id}`);
      console.log(`State: ${output.state_summary ?? output.state}`);
      console.log(`Mount: ${output.mounted ? (output.remote_path_matches ? 'active SSHFS' : 'SSHFS target mismatch') : 'not mounted'}`);
      console.log(`Path: ${output.mountpoint}`);
      console.log(`Remote active: ${output.remote_path}`);
      console.log(`Manifest visible: ${output.package_manifest_visible ? 'yes' : 'no'}`);
    });
  }

  if (action === 'remount') {
    const existing = mountInfo(localMount);
    if (existing && !isSshfsMount(existing)) {
      return fail(flags, 'mountpoint_occupied', existing,
        'Only an SSHFS mount created by dev-mount may be remounted.');
    }
    const removed = unmountLocal(localMount);
    if (!removed.ok) return fail(flags, removed.code, removed.detail, removed.fix);
  }

  let prepared;
  try { prepared = ensureLocalDirectory(localMount); }
  catch (error) { return fail(flags, 'local_mount_unavailable', String(error?.message ?? error), 'Use an empty local directory and retry.'); }
  const mounted = mountLocal(prepared, host, snapshot.remote_path);
  if (!mounted.ok) return fail(flags, mounted.code, mounted.detail, mounted.fix);
  const info = mountInfo(prepared);
  const output = {
    ...targetResult(snapshot, connection, prepared, info, host),
    action,
    changed: mounted.changed,
    marker: 'TERMUX_SPEECH_UI_AGENT_LIVE_EDIT_READY=1',
    sshfs_options: DEFAULT_OPTIONS,
  };
  if (!output.remote_path_matches || !output.package_manifest_visible) {
    return fail(flags, 'sshfs_mount_unverified', output, 'Unmount the unverified mount and inspect the SSH configuration.');
  }
  return emit(output, flags, (o) => {
    console.log(o.already ? '✓ SSHFS mount already points at the active Package worktree.' : '✓ SSHFS mounted the active Package worktree.');
    console.log(`  Package: ${o.package_id}`);
    console.log(`  Mountpoint: ${o.mountpoint}`);
    console.log(`  Remote active: ${o.remote_path}`);
    console.log(`  State: ${o.state_summary ?? o.state}; watcher=${o.watching ? 'on' : 'off'}`);
    console.log(`  ${o.marker}`);
  });
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct && process.argv.includes('--self-test')) {
  const checks = [
    ['package id accepts normal IDs', validPackageId('github.termux-os.service.demo')],
    ['package id rejects a path', !validPackageId('../demo')],
    ['mount path accepts an absolute directory', validMountPath('/tmp/termux-os-mount')],
    ['mount path rejects root', !validMountPath('/')],
    ['SSHFS filesystem is recognized', isSshfsMount({ fstype: 'fuse.sshfs' })],
    ['non-SSHFS filesystem is rejected', !isSshfsMount({ fstype: 'ext4' })],
    ['SSHFS source matches the configured host and active path', sourceMatches(
      { fstype: 'fuse.sshfs', source: 'user@device:/active/tree' }, 'device', '/active/tree')],
    ['SSHFS source from another host is rejected', !sourceMatches(
      { fstype: 'fuse.sshfs', source: 'other:/active/tree' }, 'device', '/active/tree')],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}
