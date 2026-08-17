# SDK directory contract

The SDK creates and operates independent Extension Package Git repositories. It must never make
`framework/packages/` a source-of-truth path, and one Package ID must never acquire a second active
worktree or runtime instance.

- Use the current Package repository when its manifest matches the requested ID.
- Otherwise use `TERMUX_OS_SOURCE_ROOT` or `~/termux-os-sources/`. The old
  `TERMUX_OS_DEV_ROOT` / `~/termux-os-dev/packages/` locations are legacy inputs for detection and
  safe archive only; no SDK command loads, watches, or syncs from them.
- Use `termux-os-sdk dev sync <id> --connection <name> --source <repo>` for host-to-device
  development. It previews the target, transfers only the selected Git repository, atomically
  replaces the installed active worktree, and reloads that same Package ID.
- Delegate release and installation to the Core Package Manager; do not duplicate its rules.
- Return non-zero on failure and include a stable error code plus a concrete next step.
- `dev-mount` may expose a user-private SSHFS view of the one reconciled active
  Installed Root worktree; it must never create a Package, worktree, runtime owner,
  or shadow data root.
- Keep templates, generated documentation, headers, and CLI help in English.
- Never generate a credential, device address, workstation path, provider identity, or engine dependency into a Package.
- Generated Adapter guidance may expose a blank `data-provider-credential` password field for an
  external provider. It must never contain a default value, use browser storage, or expose the
  saved value through a read API.
- Automated verification must report only the evidence produced by its declared checks.
- Keep `AI_AGENT_PROMPT.md`, generated manifests, and generated WebUI aligned with the current Core contracts.
- Keep `PUBLISHING.md` aligned with the public GitHub, Registry, and phone-market contracts.

Run `bash scripts/smoke-sdk.sh` after changing generators, templates, schemas, or CLI flow.
