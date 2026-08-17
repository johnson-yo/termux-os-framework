# UI Agent Live Edit

This is the generic handoff for a UI Agent working on an installed Extension
Package through the Framework SDK. The concrete connection name, Package ID,
and local mount directory belong in the operator's private handoff; they must
not be copied into Package source or public defaults.

## Start a live edit

Use the existing private connection profile and an empty local directory:

```text
termux-os-sdk dev-mount mount <connection> <package-id> <local-mount>
termux-os-sdk dev-mount status <connection> <package-id> <local-mount>
termux-os-sdk dev-mount remount <connection> <package-id> <local-mount>
termux-os-sdk dev-mount unmount <connection> <package-id> <local-mount>
```

The mount command queries Framework reconcile immediately before mounting and
uses the returned active `versions/<version>` path. It refuses conflicts,
legacy workspaces, missing watchers, unhealthy services, occupied directories,
and paths that are not the installed active worktree. It never creates or
copies a Package, worktree, runtime generation, configuration, data, asset,
archive, or rollback directory.

The local directory is an SSHFS view of the device worktree, not a second
source repository. A saved file is therefore visible to the device immediately.
The mount uses reconnect/keepalive options and disables the obvious SSHFS
attribute and directory caches. If the connection drops, run `remount` after
SSH recovers; do not use `rsync` or a whole-Package sync over an active UI edit.

## UI responsibility

The UI Agent owns product presentation only:

- Overview: show facts and current state.
- Settings: edit user-visible behavior.
- My Voice: edit identity and voice presentation.
- HTML/CSS/JS: layout, interaction, charts, and product copy.

The default write boundary is the Package's `web/` directory. Read `service/`,
the manifest, and documented state/API contracts when needed to understand the
current behavior. If a service or state API must change, record the concrete
need and hand it back to the Package owner; do not refactor runtime behavior
as part of a UI iteration.

## Prohibited actions

The UI Agent must not:

- commit, push, tag, bump a version, release, or publish the Package;
- modify Framework or the Android application;
- create another workspace, Package instance, or runtime owner;
- copy or synchronize the whole Package over the live mount;
- run dev sync against the worktree currently being edited;
- modify `active.json`, configuration, data, assets, archive, or rollback material;
- restore retired development workspaces;
- change service/runtime logic without the Package owner's decision.

## Handoff back

After the user accepts the UI, stop writing and unmount the view. The Package
owner then reviews the phone-side diff, brings the accepted UI change back to
the authoritative host Git source, tests it, and performs the normal Framework
dev sync/release flow. The UI Agent does not publish the Package. This ordering
prevents simultaneous edits to the live tree and the authoritative source from
creating a second divergence.
