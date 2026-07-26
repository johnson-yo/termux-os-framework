#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The current tracked and untracked publication tree, excluding ignored generated work.
 * [OUTPUT]: A non-zero exit status for legal, language, secret, identity, boundary, or artifact violations.
 * [POS]: scripts/check-publication.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this gate synchronized with README.md, SECURITY.md, and the Core boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const treeIndex = process.argv.indexOf('--tree');
if (treeIndex >= 0 && !process.argv[treeIndex + 1]) {
  console.error('Usage: node scripts/check-publication.mjs [--tree <public-tree>]');
  process.exit(2);
}
const scanRoot = treeIndex >= 0
  ? path.resolve(root, process.argv[treeIndex + 1])
  : root;
const failures = [];
const fail = (file, reason) => failures.push(`${file}: ${reason}`);
const required = [
  'README.md', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
  'SECURITY.md', 'SUPPORT.md', 'GOVERNANCE.md', 'CHANGELOG.md',
  'docs/ARCHITECTURE.md', 'docs/CONFIGURATION.md', 'docs/PACKAGE_SYSTEM.md',
  'docs/SECURITY_MODEL.md', 'docs/DEVELOPMENT.md', 'scripts/public-files.txt',
];

for (const file of required) if (!fs.existsSync(path.join(scanRoot, file))) fail(file, 'required publication file is missing');

const manifestPath = path.join(scanRoot, 'scripts', 'public-files.txt');
const manifestEntries = fs.existsSync(manifestPath)
  ? fs.readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  : [];
const manifestSet = new Set();
for (const file of manifestEntries) {
  if (manifestSet.has(file)) fail(file, 'duplicate public allowlist entry');
  if (path.isAbsolute(file) || file.split('/').includes('..')) fail(file, 'unsafe public allowlist path');
  manifestSet.add(file);
  if (!fs.existsSync(path.join(scanRoot, file))) fail(file, 'allowlisted publication file is missing');
}

const ignoredDirectories = new Set([
  '.git', '.runtime', '.runtime-dev', 'dist', 'node_modules', 'tmp', '__pycache__',
]);

function publicationFiles(dir = root, relative = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? path.posix.join(relative, entry.name) : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) out.push(...publicationFiles(full, rel));
      continue;
    }
    if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(full);
      if (resolved !== scanRoot && !resolved.startsWith(`${scanRoot}${path.sep}`)) {
        fail(rel, 'symbolic link escapes the publication tree');
        continue;
      }
    }
    out.push(rel);
  }
  return out;
}

const actualFiles = publicationFiles(scanRoot).sort();
if (treeIndex >= 0) {
  for (const file of actualFiles) if (!manifestSet.has(file)) fail(file, 'file is not in the public allowlist');
  for (const file of manifestEntries) if (!actualFiles.includes(file)) fail(file, 'allowlisted file is absent from exported tree');
}
const files = treeIndex >= 0 ? actualFiles : manifestEntries;
if (files.length < required.length) fail('.', 'publication scan did not discover the source tree');

if (files.some((file) => file === 'packages' || file.startsWith('packages/'))) {
  fail('packages/', 'first-party Package source must not be bundled in Framework Core');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(scanRoot, 'package.json'), 'utf8'));
if (packageJson.private === true) fail('package.json', 'public Core must not be marked private');
if (packageJson.license !== 'Apache-2.0') fail('package.json', 'license must be Apache-2.0');

const commentExtensions = new Set(['.mjs', '.js', '.sh', '.py', '.css', '.html', '.c', '.cc', '.cpp', '.h', '.hpp']);
const allowedSyntheticBinary = new Set(['sdk/examples/asset-model/payload/example-model/model.bin']);
const binaryExtensions = /\.(?:onnx|ort|gguf|tflite|pt|pth|safetensors|bin)$/i;
const han = /\p{Script=Han}/u;
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/,
];
// Keep the detector generic. Concrete workstation paths, device aliases,
// addresses, and credentials must never be copied into this public gate: the
// gate itself is part of the publication tree and is scanned by the same gate.
const privatePathPattern = new RegExp(
  ['\\/(?:home|mnt|Users)\\/[A-Za-z0-9._-]+', '(?:\\/[A-Za-z0-9._-]+)+'].join(''),
);
const privateNetworkPattern = new RegExp(
  ['\\b(?:10|192\\.168|172\\.(?:1[6-9]|2\\d|3[01]))', '\\.[0-9]{1,3}', '\\.[0-9]{1,3}', '\\.[0-9]{1,3}\\b'].join(''),
);
const weakCredentialPattern = new RegExp(
  ['(?:token|password|secret)\\s*[:=]\\s*["\\\']?', '[0-9]{8,}'].join(''),
  'i',
);
const identityPatterns = [
  { re: privatePathPattern, label: 'private workstation path' },
  { re: privateNetworkPattern, label: 'private network address' },
  { re: weakCredentialPattern, label: 'weak fixed credential' },
];

function leadingHeader(text, ext) {
  let source = text.startsWith('#!') ? text.slice(text.indexOf('\n') + 1) : text;
  source = source.replace(/^\s+/, '');
  if (ext === '.sh' || ext === '.py') return source.split('\n').slice(0, 6).join('\n');
  if (ext === '.html') return source.slice(0, source.indexOf('-->') + 3);
  return source.slice(0, source.indexOf('*/') + 2);
}

for (const file of files) {
  const full = path.join(scanRoot, file);
  const ext = path.extname(file);
  if (binaryExtensions.test(file) && !allowedSyntheticBinary.has(file)) fail(file, 'model or opaque binary is not allowed in Core');
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }

  if (file.endsWith('.md') && han.test(text)) fail(file, 'public Markdown must be English');
  if (commentExtensions.has(ext)) {
    const header = leadingHeader(text, ext);
    if (!header.includes('SPDX-License-Identifier: Apache-2.0')) fail(file, 'Apache-2.0 SPDX header is missing');
    if (han.test(header)) fail(file, 'file header must be English');
  }
  if (/\[(?:INPUT|OUTPUT|POS|PROTOCOL)\][^\n]*\p{Script=Han}/u.test(text)) {
    fail(file, 'embedded generated file header must be English');
  }
  for (const pattern of credentialPatterns) if (pattern.test(text)) fail(file, 'possible credential or private key');
  for (const { re, label } of identityPatterns) {
    if (!re.test(text)) continue;
    fail(file, label);
  }
}

if (failures.length) {
  console.error(`Publication check failed (${failures.length}):`);
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`PASS publication tree: ${files.length} files checked`);
