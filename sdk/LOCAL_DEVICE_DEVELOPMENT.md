# Local device development

The supported workflow has one source repository on the host and one active Installed Root worktree
on the device:

```text
host Git repository → dev sync → phone active worktree → Framework reload
```

Create or select the source repository under `~/termux-os-sources/` (or pass `--source` explicitly),
then preview and sync it:

```sh
termux-os-sdk status <package-id> --connection <name> --json
termux-os-sdk dev sync <package-id> \
  --connection <name> --source /absolute/path/to/repository
termux-os-sdk dev status <package-id> --connection <name> --json
```

The sync checks the Package ID and version, excludes `.sdk`, `tmp`, `backup`, and local backup
artifacts, transfers only the selected Git repository, swaps the active version atomically, and
reloads the same Package ID. `config/`, persistent data, assets, and the rollback archive are not
part of the source sync. A failed swap or reload restores the previous active tree.

`~/termux-os-dev/packages/` and `TERMUX_OS_DEV_ROOT` are retired legacy locations. Framework and
SDK report them and provide `legacy-archive`, but never load, watch, or silently delete their
contents. `previous`, `archive`, and runtime generations are recovery/cache material, not active
Package instances. Resolve any duplicate or legacy conflict before a write operation.

Do not put a phone address, SSH alias, or token in Package source. Models remain in
`/sdcard/termux-os/models/`; Package code and private state remain in Termux-private storage.

When a Package needs an Android application or hardware feature, use an adapter contract. Do not
make that application a Framework startup dependency.
