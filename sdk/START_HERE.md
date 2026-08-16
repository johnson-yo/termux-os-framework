# Extension Package SDK

The SDK is the shortest supported path from an independent Package source repository to an immutable installed release.

For a public GitHub + Package Registry + phone-market release, read
[Public Package publication](PUBLISHING.md) after this page. It explains the
two archive identities, the Registry review/publish boundary, credential
separation, and the final catalog-install acceptance path.

For an AI-assisted implementation, begin with
[the copy-ready Agent prompt](AI_AGENT_PROMPT.md). It captures the current
Package boundary, Browser Session, System Key, port, mobile WebUI, and release
contracts in one place.

Use `termux-os-sdk` when the executable is on `PATH`. Otherwise invoke
`<framework-root>/sdk/termux-os-sdk`. Package source never belongs under a
Framework-owned `packages/` directory.

## 1. Choose the type

```sh
termux-os-sdk choose \
  --extends-existing no \
  --data-only no \
  --integrates-external no \
  --long-running yes \
  --combines-capabilities no
```

See [Package types](PACKAGE_TYPES.md).

## 2. Create or inspect a Package

```sh
termux-os-sdk new \
  --type service \
  --id org.example.service.demo \
  --name "Demo Service"

termux-os-sdk inspect org.example.service.demo
```

The default source root is `~/termux-os-sources/`. Set `TERMUX_OS_SOURCE_ROOT` to use another
collection, or run the SDK from the Package Git repository itself. The old
`~/termux-os-dev/packages/` tree is legacy: `context` and `reconcile` report it, but the SDK never
loads or watches it.

## 3. Build confidence

```sh
termux-os-sdk doctor org.example.service.demo
termux-os-sdk test org.example.service.demo
termux-os-sdk dev sync org.example.service.demo \
  --connection <name> --source /absolute/path/to/the/repository
termux-os-sdk dev start org.example.service.demo
```

`dev` watches the installed active worktree; it does not create a second Package. A sync is atomic,
keeps `config/`, persistent data, and assets outside the version directory, and reports the target
path and Git diff before replacing it. Runtime generations are module-cache copies only and never
become Package identities.

## 4. Release and install

```sh
termux-os-sdk release org.example.service.demo
termux-os-sdk install /absolute/path/to/release.tar.gz
termux-os-sdk verify-device org.example.service.demo
termux-os-sdk handoff org.example.service.demo
```

The release path is Source → deterministic archive → verification → target check → immutable Installed Root. Read [the contracts](CONTRACTS.md) before adding native code or model assets.
