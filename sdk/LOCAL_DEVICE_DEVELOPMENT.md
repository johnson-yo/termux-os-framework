# Local device development

Framework and the SDK are local-first. On a phone, keep Package workspaces under `~/termux-os-dev/packages/` and use the default loopback Framework URL.

Use a connection profile only when the SDK runs on another machine. Do not put a phone address, SSH alias, or token in Package source. Models remain in `/sdcard/termux-os/models/`; Package code and private state remain in Termux-private storage.

When a Package needs an Android application or hardware feature, use an adapter contract. Do not make that application a Framework startup dependency.
