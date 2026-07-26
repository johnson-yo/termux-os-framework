#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A source tree and scripts/public-files.txt.
 * [OUTPUT]: A clean, allowlisted public source tree under tmp/.
 * [POS]: The publication boundary between local Framework development and the public repository.
 * [PROTOCOL]: Keep the allowlist and publication checks synchronized when files change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'scripts', 'public-files.txt');
const defaultOutput = path.join(root, 'tmp', 'public-tree');

function fail(message) {
  console.error(`Public export failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  if (outputIndex >= 0 && !argv[outputIndex + 1]) fail('--output requires a directory');
  return { output: outputIndex >= 0 ? argv[outputIndex + 1] : defaultOutput };
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) fail(`missing ${path.relative(root, manifestPath)}`);
  const entries = fs.readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) fail(`duplicate manifest entry: ${entry}`);
    if (path.isAbsolute(entry) || entry.split('/').includes('..')) {
      fail(`unsafe manifest path: ${entry}`);
    }
    seen.add(entry);
  }
  return entries;
}

function safeOutput(output) {
  const resolved = path.resolve(root, output);
  const tempRoot = path.join(root, 'tmp') + path.sep;
  if (!resolved.startsWith(tempRoot)) fail('output must be inside Framework tmp/');
  if (resolved === root || resolved === path.join(root, 'tmp')) fail('output path is too broad');
  return resolved;
}

const { output: requestedOutput } = parseArgs(process.argv.slice(2));
const output = safeOutput(requestedOutput);
const entries = readManifest();

if (fs.existsSync(output)) fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const entry of entries) {
  const source = path.join(root, entry);
  const target = path.join(output, entry);
  if (!fs.existsSync(source) && !fs.lstatSync(source, { throwIfNoEntry: false })) {
    fail(`manifest file is missing: ${entry}`);
  }
  const stat = fs.lstatSync(source);
  if (!stat.isFile() && !stat.isSymbolicLink()) fail(`manifest entry is not a file: ${entry}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
  else fs.copyFileSync(source, target);
}

console.log(`PASS public export: ${entries.length} files -> ${path.relative(root, output)}`);
