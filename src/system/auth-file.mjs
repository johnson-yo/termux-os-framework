/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/auth-file.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const AUTH_SCHEMA = 'termux-os-framework.auth.v1';
export const AUTH_TOKEN_MIN_LENGTH = 32;
export const AUTH_PASSWORD_MIN_LENGTH = 16;
export const defaultAuthFile = () => process.env.FRAMEWORK_AUTH_FILE
  || path.join(os.homedir(), '.termux-os', 'secrets', 'framework-auth.v1.json');

export const generateAuthToken = () => crypto.randomBytes(32).toString('base64url');
export const generateAdminPassword = () => crypto.randomBytes(18).toString('base64url');

function validate(value, file) {
  if (value?.schema !== AUTH_SCHEMA
    || typeof value.admin_token !== 'string' || value.admin_token.length < AUTH_TOKEN_MIN_LENGTH
    || typeof value.admin_password !== 'string' || value.admin_password.length < AUTH_PASSWORD_MIN_LENGTH) {
    throw new Error(`invalid framework authentication file: ${file}`);
  }
  return value;
}

export function readAuthFile(file = defaultAuthFile()) {
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

export function ensureAuthFile(file = defaultAuthFile()) {
  try {
    const value = readAuthFile(file);
    try { fs.chmodSync(file, 0o600); } catch { /* Some filesystems do not expose POSIX modes. */ }
    return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = {
    schema: AUTH_SCHEMA,
    admin_token: generateAuthToken(),
    admin_password: generateAdminPassword(),
    created_at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readAuthFile(file);
  }
  return value;
}

/** Update the private credential file without exposing a partially written secret. */
export function writeAuthFile(file = defaultAuthFile(), patch = {}) {
  const current = fs.existsSync(file) ? readAuthFile(file) : ensureAuthFile(file);
  const next = validate({
    ...current,
    ...patch,
    schema: AUTH_SCHEMA,
    updated_at: new Date().toISOString(),
  }, file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return readAuthFile(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] ?? 'ensure';
  const file = process.argv[3] ?? defaultAuthFile();
  const value = ensureAuthFile(file);
  if (command === 'ensure') console.log(file);
  else if (command === 'show') console.log(JSON.stringify({ file, ...value }, null, 2));
  else {
    console.error('usage: node src/system/auth-file.mjs [ensure|show] [file]');
    process.exitCode = 2;
  }
}
