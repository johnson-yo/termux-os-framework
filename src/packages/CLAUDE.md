# Package runtime contract

Runtime truth is the Installed Root at `~/.termux-os/packages/`. Source repositories are external,
release archives are immutable, and Dev Runtime reloads the one active worktree in place. A
generation is only a module-cache copy and never a second Package.

Package loading is failure-isolated. Manifests, declared artifacts, targets, paths, and compatibility are validated before activation. HTTP routes and authenticated WebSocket routes are registered per Package and removed with the Package. Fixtures in `fixtures/` are test-only and must never load during normal empty-Core startup.

Supervised Package services receive `TERMUX_OS_PORT_<ID>_HOST` and
`TERMUX_OS_PORT_<ID>_VISIBILITY` alongside their assigned port. A direct HTTP
listener must honor these Framework-injected values; the default is loopback.

A Package keeps its own settings under `config/` in its Package root, beside `versions/` rather than
inside one, reached through `context.configFile(name)`. The SDK used to point Packages at
`persistRoot/conf/`, which is the Framework's own configuration directory: a Package's settings then
depended on the Framework's persistent tree, and that tree is what the update boundary check
inspects. The new location survives both a Framework update and an upgrade of the Package itself.
A file still at the old location is copied across the first time it is asked for, and the original
is left in place so downgrading the Package still finds it.

A directory under the Installed Root that has `versions/` but no `active.json` is reported as a
failed Package rather than skipped. Skipping it left the user with something they could neither see,
remove, nor reinstall without opening a shell to find out why it had vanished.

Dependency resolution has two callers with different authority. Runtime and
normal Registry-assisted preflight may use the cached catalog to describe a
possible supply. Both probe Capabilities on the device first: only a required
Capability with no provider here is supplied from the catalog, an optional one
is listed with its provider but never installed, and `install_order` /
`download_bytes` are derived from `supply` alone. Local archive installation uses the local-only resolver: it
reports the installed Package/Capability/Asset facts, never manufactures a
remote supply plan, and blocks on any required dependency that is not already
ready on the device.

## `.models` declarations

An installed Package version may declare raw model consumers with empty files at
`.models/<owner>/<repository>` in the active version root. Core exposes the read-only enumeration through
`GET /api/packages/model-declarations`; it validates the active Installed Root,
keeps malformed paths visible as errors, and does not persist a second consumer
ledger. The declaration is package-local data: a Package update preserves it,
while Package uninstall removes it with the Package root.

## Asset payload boundary

An Asset Package owns Asset declaration, registration, and package-install
provisioning. A replaceable Manager Package owns the payload lifecycle after
registration: source selection, download/resume, verification, storage, update,
delete confirmation, and deletion. Core may provide generic path, transfer,
integrity, and atomic-storage primitives, but it must not turn `optional`,
provider load state, or `.models` declarations into a lifecycle permission check.
Deleting payload bytes must be separate from unregistering the Asset declaration.
