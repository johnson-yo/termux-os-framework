# termux-os-framework

`termux-os-framework` is a local-first control plane for installing, supervising, updating, and coordinating replaceable components on Android through Termux. It uses Node.js standard-library APIs and ships with no runtime npm dependencies.

The repository is Framework Core. It is intentionally useful when no Extension Package is installed.

## Core boundary

Core provides:

- immutable Package release, verification, installation, rollback, and removal;
- Package manifests, runtime contracts, device-target checks, and asset registration;
- Capability discovery and provider binding;
- service desired state, process supervision, health, and logs;
- application coordination and isolated development mounts;
- authenticated HTTP APIs, a browser administration shell, device verification, and atomic Framework updates;
- an SDK for creating and releasing independent Extension Package repositories.

Core does not provide audio capture or playback, PCM/RMS/KWS/VAD/ASR/TTS processing, language models, translation engines, model files, vendor SDKs, device adapters, chat applications, or other product features. Those are Extension Packages or companion applications and may be replaced independently.

An Extension Package communicates through versioned Manifest, Capability, Action, Feed, HTTP, or WebSocket contracts. Its license remains its own. Installing or connecting it does not make it part of the Apache-2.0 Core distribution.

## Requirements

- Node.js 20 or newer
- Linux or Termux for process supervision
- `bash`, `curl`, `tar`, and `sha256sum` for lifecycle and release commands
- Python 3 only for deterministic archive creation

No engine, model, Android application, or vendor SDK is required to start Core.

## Quick start

For an official verified install on Termux, use the independent installer from
the Framework source archive and let the Package Registry select the latest
verified `framework` release:

```sh
bash scripts/install.sh
```

See [Framework installation](docs/FRAMEWORK_INSTALLATION.md) for bootstrap,
upgrade, rollback, uninstall, and public-source boundary details. To run a
checked-out source tree directly instead:

```sh
npm start
```

The server listens on `127.0.0.1:8980` by default. On first start it creates random administrator credentials at:

```text
~/.termux-os/secrets/framework-auth.v1.json
```

The file is created with owner-only permissions where the filesystem supports them. Show the credentials only when needed:

```sh
node src/system/auth-file.mjs show
```

Then open `http://127.0.0.1:8980/admin` or check health:

```sh
curl http://127.0.0.1:8980/health
```

To expose the service to a trusted LAN, explicitly change `server.host` in a private configuration copy or set `HOST=0.0.0.0`. Read [the security model](docs/SECURITY_MODEL.md) first.

## Extension development

Package source does not live in this repository. The SDK uses the current Package repository or `~/termux-os-dev/packages/`:

```sh
./sdk/termux-os-sdk new \
  --type service \
  --id org.example.service.demo \
  --name "Demo Service"

./sdk/termux-os-sdk doctor org.example.service.demo
./sdk/termux-os-sdk test org.example.service.demo
./sdk/termux-os-sdk release org.example.service.demo
```

Start with [SDK documentation](sdk/START_HERE.md) and [the Package system](docs/PACKAGE_SYSTEM.md).

## Storage contract

| Purpose | Default location | Update behavior |
|---|---|---|
| Framework runtime | `~/.termux-os/framework/` | atomically replaceable |
| Installed Packages | `~/.termux-os/packages/` | managed independently |
| Private credentials and browser sessions | `~/.termux-os/` | never placed on shared storage |
| Framework configuration and state | `/sdcard/termux-os/framework/` | preserved across updates |
| Models and immutable model assets | `/sdcard/termux-os/models/` | downloaded only when missing or incompatible |
| Shared caches | `/sdcard/termux-os/caches/` | preserved and independently managed |

Privacy-sensitive temporary audio belongs in an Android application's private storage. Core neither records nor stores audio.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Configuration and deployment](docs/CONFIGURATION.md)
- [Package system](docs/PACKAGE_SYSTEM.md)
- [Security model](docs/SECURITY_MODEL.md)
- [Framework installation](docs/FRAMEWORK_INSTALLATION.md)
- [Development and testing](docs/DEVELOPMENT.md)
- [Public source boundary](scripts/public-files.txt)

## License

Framework Core is licensed under the [Apache License 2.0](LICENSE). Extension Packages, engines, models, applications, and vendor components are separate works and must publish their own license and attribution information.
