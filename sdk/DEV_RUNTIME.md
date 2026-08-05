# Development Runtime

Dev Runtime mounts an external Package workspace into a running local Framework and temporarily shadows an installed version with the same ID.

```sh
termux-os-sdk dev start <package-id>
termux-os-sdk dev status <package-id>
termux-os-sdk dev reload <package-id>
termux-os-sdk dev logs <package-id>
termux-os-sdk dev stop <package-id>
```

The default data mode is isolated. `--use-live-data` is intentionally explicit because development code can damage production data. A Dev page is visibly marked and cannot be used as release verification evidence. Stopping Dev Runtime restores the untouched Installed Package.

A mounted page is served at `/packages/<package-id>@<workspace-slug>/`. Its same-origin API calls
must use that active path segment, not a hard-coded release Package ID; otherwise a new Workspace
calls a nonexistent release, or silently controls the installed Package instead of its Dev instance.
Current SDK-generated WebUI derives the active ID from `location.pathname`.
