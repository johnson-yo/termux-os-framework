# Troubleshooting

Start with facts:

```sh
termux-os-sdk context
termux-os-sdk inspect <package-id>
termux-os-sdk doctor <package-id>
termux-os-sdk status <package-id> --json
```

Common states:

- `framework_unreachable`: start Framework or correct the private connection profile.
- `package_not_found`: run from the Package Git repository or set `TERMUX_OS_SOURCE_ROOT` / pass
  `--source`; the retired `TERMUX_OS_DEV_ROOT` tree is report-only.
- `package_reconcile_required`: inspect `termux-os-sdk dev status <id> --json` or
  `node scripts/package-manager.mjs reconcile <id>`. Resolve duplicate active records, stale
  generations, or archive the reported legacy workspace before writing.
- `doctor_failed`: fix every reported failure before release.
- `missing_asset`: install a compatible asset Package; do not copy a model into Core.
- `target_mismatch`: build or select a release for the reported device target.
- `verify-stale`: rerun device verification for the currently installed identity.
- `dev_runtime_active`: stop the watcher before release verification; the Package itself remains
  the one active worktree and its Git state is still authoritative.

Sanitize logs before sharing them.
