# Development and verification

## Local Core workflow

```sh
npm start
npm test
npm run check:public
```

Tests use temporary homes, ports, Installed Roots, and fixtures. They must not require a phone, model, vendor SDK, network account, or existing Package repository.

## Syntax checks

The test command checks JavaScript modules, shell scripts, Python helpers, Core self-tests, Package release contracts, the SDK, authentication, and an empty-Core startup.

## Extension workflow

Run the SDK from an independent Package repository or set `TERMUX_OS_DEV_ROOT`:

```sh
export TERMUX_OS_DEV_ROOT="$HOME/termux-os-dev/packages"
./sdk/termux-os-sdk context
./sdk/termux-os-sdk new --type adapter --id org.example.adapter.device --name "Device Adapter"
```

Use `doctor`, `test`, `release`, `install`, `verify-device`, and `handoff` in that order.

## Publication gate

`npm run check:public` rejects missing legal files, non-English Markdown or source headers, embedded credentials, private addresses, workstation paths, first-party Package source, and model binaries outside explicit tiny fixtures.
