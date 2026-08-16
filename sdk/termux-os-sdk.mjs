#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: sdk/termux-os-sdk.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import { parseArgs } from './lib/util.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseArgs(rest);

const HELP = `termux-os-sdk — Extension Package SDK

Start here: sdk/START_HERE.md
AI Agent prompt: sdk/AI_AGENT_PROMPT.md

Without connection flags, commands use the local Framework at
http://127.0.0.1:8980. For another device, use a private
--connection <name> profile from ~/.termux-os-sdk/connections/, or use
--framework-url <url>. --remote <host> remains an SSH compatibility alias.

  context [--json] [--remote <host>]   Show architecture and source repositories
  access [<package-id>]                Show local and LAN browser URLs
  inspect <package-id> [--json]        Inspect one Package source repository
  choose [--<question> yes|no] [--json] Choose the smallest Package type
  new --type <t> --id <id> --name <n> [--out-dir <dir>]
                                       Generate source in a Git-oriented source root;
                                       legacy ~/termux-os-dev/packages is not used
  dev start|status|reload|logs|stop <package-id>
                                       Watch/reload the one active worktree
  dev sync <package-id> --connection <c> [--source <repo>]
                                       Atomically sync host Git source to active device code
  doctor <package-id> [--json]         Validate current Package contracts
  status <package-id> [--json]         Show source/Dev/Release/Installed/
                                       Running/Verify truth and drift
  next <package-id> [--json]           Show the next evidence-producing step
  test <package-id> [--json]           Run only this Package's tests and doctor
  release <package-id> [--target <t>] [--artifact-dir <d>]  doctor→test→pack→verify
  install <tar> [--connection <c>]     Transfer→check→install→check-installed
  verify-device <package-id> [--dev]   Run the declared device verification hook;
                                       installed mode binds exact Release identity
  handoff <package-id>                 Generate current-facts handoff material

Every command exits zero only on success. --json emits one machine-readable
object. Failures include a stable code and a concrete next step.`;

async function main() {
  switch (cmd) {
    case 'context': return (await import('./lib/context.mjs')).cmdContext(flags);
    case 'access': return (await import('./lib/connection.mjs')).cmdAccess(flags, pos);
    case 'inspect': return (await import('./lib/context.mjs')).cmdInspect(flags, pos);
    case 'choose': return (await import('./lib/context.mjs')).cmdChoose(flags);
    case 'new': return (await import('./lib/generate.mjs')).cmdNew(flags, pos);
    case 'dev': return (await import('./lib/dev.mjs')).cmdDev(flags, pos);
    case 'status': return (await import('./lib/status.mjs')).cmdStatus(flags, pos);
    case 'doctor': return (await import('./lib/doctor.mjs')).cmdDoctor(flags, pos);
    case 'next': return (await import('./lib/doctor.mjs')).cmdNext(flags, pos);
    case 'test': return (await import('./lib/flow.mjs')).cmdTest(flags, pos);
    case 'release': return (await import('./lib/flow.mjs')).cmdRelease(flags, pos);
    case 'install': return (await import('./lib/flow.mjs')).cmdInstall(flags, pos);
    case 'verify-device': return (await import('./lib/verify.mjs')).cmdVerifyDevice(flags, pos);
    case 'handoff': return (await import('./lib/flow.mjs')).cmdHandoff(flags, pos);
    case 'help': case undefined: case '--help': console.log(HELP); return;
    default:
      console.error(`✗ unknown_command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, code: 'sdk_internal_error', detail: String(e?.stack ?? e) }));
  process.exit(1);
});
