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
