#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework-injected URL and System Key on the target device.
 * [OUTPUT]: One truthful termux-os.device-verify.v1 result.
 * [POS]: Device verification for the SDK service example.
 * [PROTOCOL]: Bind only the checks actually performed by this script.
 */

const BASE = process.env.TERMUX_OS_FRAMEWORK_URL ?? 'http://127.0.0.1:8980';
const TOKEN = process.env.TERMUX_OS_SYSTEM_KEY ?? process.env.TERMUX_OS_TOKEN ?? '';
const checks = [];
const check = async (id, fn) => {
  try { checks.push({ id, result: 'pass', evidence: await fn() }); }
  catch (error) { checks.push({ id, result: 'fail', evidence: String(error?.message ?? error) }); }
};
const get = async (pathname) => {
  const response = await fetch(BASE + pathname, {
    signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status} ${pathname}`);
  return `HTTP 200 ${pathname}`;
};

await check('package_identity', () => get('/api/packages/github.termux-os.service.example-counter'));
await check('status_api', () => get('/api/packages/github.termux-os.service.example-counter/status'));
const result = checks.some((item) => item.result === 'fail') ? 'fail' : 'pass';
console.log(JSON.stringify({ schema: 'termux-os.device-verify.v1', result, checks }));
process.exit(result === 'fail' ? 1 : 0);
