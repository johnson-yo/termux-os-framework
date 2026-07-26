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
- `package_not_found`: run from the Package repository or set `TERMUX_OS_DEV_ROOT`.
- `doctor_failed`: fix every reported failure before release.
- `missing_asset`: install a compatible asset Package; do not copy a model into Core.
- `target_mismatch`: build or select a release for the reported device target.
- `verify-stale`: rerun device verification for the currently installed identity.
- `dev_runtime_active`: stop Dev Runtime before release verification.

Sanitize logs before sharing them.
