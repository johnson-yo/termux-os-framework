#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The Framework public allowlist, package version, and a tmp output path.
 * [OUTPUT]: A symlink-free, deterministic Framework source archive and SHA-256 sidecar.
 * [POS]: The local source-release boundary used before a Framework archive is uploaded.
 * [PROTOCOL]: Export and publication checks run before generated deployment metadata is injected.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const versionIndex = argv.indexOf('--version');
  const outputIndex = argv.indexOf('--output');
  const version = versionIndex >= 0 ? argv[versionIndex + 1] : packageJson.version;
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : `tmp/framework-${version}-source.tar.gz`;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail(`invalid Framework version: ${version ?? '(missing)'}`);
  if (!output) fail('--output requires a file');
  return { version, output };
}

function assertTmpPath(requested, label) {
  const resolved = path.resolve(root, requested);
  const tmpRoot = `${path.join(root, 'tmp')}${path.sep}`;
  if (!resolved.startsWith(tmpRoot)) fail(`${label} must be inside Framework tmp/`);
  return resolved;
}

function treeEntries(dir, relative = '') {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? path.posix.join(relative, item.name) : item.name;
    const full = path.join(dir, item.name);
    if (item.isSymbolicLink()) {
      entries.push({ full, rel, type: 'symlink' });
    } else if (item.isDirectory()) {
      entries.push({ full, rel, type: 'directory' }, ...treeEntries(full, rel));
    } else if (item.isFile()) {
      entries.push({ full, rel, type: 'file' });
    } else {
      fail(`unsupported source entry type: ${rel}`);
    }
  }
  return entries;
}

function archiveSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const { version, output: requestedOutput } = parseArgs(process.argv.slice(2));
const output = assertTmpPath(requestedOutput, 'archive output');
const work = fs.mkdtempSync(path.join(root, 'tmp', 'framework-archive-'));
const publicTree = path.join(work, 'public-tree');
const stagingParent = path.join(work, 'stage');
const staging = path.join(stagingParent, 'framework');

try {
  fs.rmSync(output, { force: true });
  fs.rmSync(`${output}.sha256`, { force: true });
  execFileSync(process.execPath, [path.join(root, 'scripts/export-public-tree.mjs'), '--output', publicTree], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(root, 'scripts/check-publication.mjs'), '--tree', publicTree], { stdio: 'inherit' });

  fs.mkdirSync(stagingParent, { recursive: true });
  fs.cpSync(publicTree, staging, { recursive: true, dereference: true });
  const forbidden = treeEntries(staging).filter((entry) => entry.type === 'symlink');
  if (forbidden.length) fail(`source tree contains symlink(s): ${forbidden.map((entry) => entry.rel).join(', ')}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
  if (manifest.version !== version) fail(`package.json version ${manifest.version} does not match ${version}`);
  fs.writeFileSync(path.join(staging, '.deploy-id'), `framework-${version}\n`, { mode: 0o644 });

  const executable = treeEntries(staging)
    .filter((entry) => entry.type === 'file' && (entry.rel.endsWith('.sh') || entry.rel === 'sdk/termux-os-sdk'))
    .flatMap((entry) => ['--exec', entry.rel]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('python3', [
    path.join(root, 'scripts/reproducible-archive.py'),
    '--root', stagingParent, '--top', 'framework', '--out', output, ...executable,
  ], { stdio: 'inherit' });

  const listing = execFileSync('tar', ['-tvzf', output], { encoding: 'utf8' });
  const nonRegular = listing.split(/\r?\n/).filter((line) => line && !['-', 'd'].includes(line[0]));
  if (nonRegular.length) fail(`archive contains non-regular entry type: ${nonRegular[0]}`);
  const digest = archiveSha256(output);
  fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`, { mode: 0o644 });
  console.log(`PASS Framework archive: ${path.relative(root, output)} (${fs.statSync(output).size} bytes)`);
  console.log(`SHA-256: ${digest}`);
} catch (error) {
  console.error(`Framework archive failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
