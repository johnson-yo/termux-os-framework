# Package runtime contract

Runtime truth is the Installed Root at `~/.termux-os/packages/`. Source repositories are external, release archives are immutable, and Dev Runtime shadows are explicit and temporary.

Package loading is failure-isolated. Manifests, declared artifacts, targets, paths, and compatibility are validated before activation. HTTP routes and authenticated WebSocket routes are registered per Package and removed with the Package. Fixtures in `fixtures/` are test-only and must never load during normal empty-Core startup.

Supervised Package services receive `TERMUX_OS_PORT_<ID>_HOST` and
`TERMUX_OS_PORT_<ID>_VISIBILITY` alongside their assigned port. A direct HTTP
listener must honor these Framework-injected values; the default is loopback.
