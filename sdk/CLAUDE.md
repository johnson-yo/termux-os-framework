# SDK directory contract

The SDK creates and operates independent Extension Package workspaces. It must never make `framework/packages/` a source-of-truth path.

- Use the current Package repository when its manifest matches the requested ID.
- Otherwise use `TERMUX_OS_DEV_ROOT` or `~/termux-os-dev/packages/`.
- Delegate release and installation to the Core Package Manager; do not duplicate its rules.
- Return non-zero on failure and include a stable error code plus a concrete next step.
- Keep templates, generated documentation, headers, and CLI help in English.
- Never generate a credential, device address, workstation path, provider identity, or engine dependency into a Package.
- Automated verification must report only the evidence produced by its declared checks.
- Keep `AI_AGENT_PROMPT.md`, generated manifests, and generated WebUI aligned with the current Core contracts.
- Keep `PUBLISHING.md` aligned with the public GitHub, Registry, and phone-market contracts.

Run `bash scripts/smoke-sdk.sh` after changing generators, templates, schemas, or CLI flow.
