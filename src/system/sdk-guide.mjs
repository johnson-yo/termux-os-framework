/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The Framework root, Framework version, and canonical SDK Agent prompt.
 * [OUTPUT]: A stable administration snapshot containing the copy-ready prompt.
 * [POS]: src/system/sdk-guide.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SDK_GUIDE_SCHEMA = 'termux-os.sdk-guide.v1';
export const SDK_GUIDE_SOURCE = 'sdk/AI_AGENT_PROMPT.md';

export function sdkGuideSnapshot({ frameworkRoot, frameworkVersion }) {
  const prompt = fs.readFileSync(path.join(frameworkRoot, SDK_GUIDE_SOURCE), 'utf8').trim();
  if (!prompt) throw new Error('SDK Agent prompt is empty');
  return {
    ok: true,
    schema: SDK_GUIDE_SCHEMA,
    framework_version: frameworkVersion,
    source: SDK_GUIDE_SOURCE,
    prompt,
  };
}

const { fileURLToPath: selfTestUrl } = await import('node:url');
const { resolve: selfTestPath } = await import('node:path');
// ⚠ 只在**本檔被直接執行**時跑。少了 argv[1] 這半，任何 transitively import 本檔的
// 自檢都會被這一塊劫持並提前 process.exit——那個自檢的斷言一條也不會執行，
// 而輸出看起來完全正常，只是印的是別人的 PASS。
if (process.argv.includes('--self-test')
  && process.argv[1] && selfTestPath(process.argv[1]) === selfTestUrl(import.meta.url)) {
  let fails = 0;
  const test = (name, condition) => {
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    if (!condition) fails++;
  };
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const result = sdkGuideSnapshot({ frameworkRoot: root, frameworkVersion: 'test' });
  test('SDK guide schema', result.schema === SDK_GUIDE_SCHEMA);
  test('SDK guide covers assigned ports', result.prompt.includes('TERMUX_OS_PORT_<ID>'));
  test('SDK guide covers the System Key', result.prompt.includes('TERMUX_OS_SYSTEM_KEY'));
  test('SDK guide covers Browser Session', result.prompt.includes('window.TermuxOS.api'));
  test('SDK guide covers portrait phone layout', result.prompt.includes('portrait phone'));
  test('SDK guide rejects the retired source layout', result.prompt.includes('`framework/packages/`'));
  process.exit(fails ? 1 : 0);
}
