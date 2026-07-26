# Configuration and deployment

## Public defaults

`config/defaults/framework.v1.json` contains no secret or device-specific value. It binds to loopback, uses port 8980, disables developer mode, and declares the public Package Registry origin without any credential.

Copy it to a private writable location before making persistent changes:

```sh
mkdir -p /sdcard/termux-os/framework/conf
cp config/defaults/framework.v1.json \
  /sdcard/termux-os/framework/conf/framework.v1.json
```

The lifecycle controller uses that location by default on Termux.

## Important environment variables

| Variable | Purpose |
|---|---|
| `CONFIG` or `FRAMEWORK_CONFIG` | configuration file |
| `HOST`, `PORT` | explicit server bind override |
| `FRAMEWORK_AUTH_FILE` | private authentication file |
| `PACKAGES_INSTALLED_DIR` | Installed Root |
| `FRAMEWORK_RUNTIME` | replaceable Framework runtime |
| `FRAMEWORK_PERSIST` | persistent Framework state |
| `FRAMEWORK_ASSET_ROOT` | immutable shared model/asset root |
| `TERMUX_OS_DEV_ROOT` | external Package development workspace |
| `TERMUX_OS_TOKEN` | SDK API token supplied outside source |
| `PACKAGE_REGISTRY_URL` | override the public Package Registry origin (HTTPS; local HTTP is allowed only for loopback tests) |
| `PACKAGE_REGISTRY_PATH` | private persistent catalog snapshot path (default: `~/.termux-os/package-registry.v1.json`) |
| `PACKAGE_REGISTRY_TIMEOUT_MS` | Registry request timeout |
| `PACKAGE_REGISTRY_DIRECT_TIMEOUT_MS` | short GitHub direct-source probe timeout (default: 6000 ms) |

## Package Registry

The default Registry origin is `https://package.termux-os.com`. The Core does
not contact it during startup. Admin refresh first retrieves the public catalog.
For a GitHub `source_tar`, a download then tries the catalog-derived GitHub tag
archive with a short bounded probe, falls back to the Registry `check` and
download endpoints, and finally exposes a manual GitHub Release URL if both
paths fail. It never accepts an arbitrary URL. Whichever remote path succeeds
must still match the catalog's exact size and SHA-256 while streaming before a
local Package Manager preflight candidate is created. Installing remains a
separate explicit action. A manually imported archive whose SHA-256 is not in
the cached verified catalog requires a separate safety acknowledgement before
installation. The cached catalog contains public metadata only and never
stores an access token.

When the private auth file is in use, `~/framework.sh reset-password` is the
local recovery path. Use `~/framework.sh reset-password --generate` for a
one-time random password, or run the command interactively to enter one. It
rotates only the login password, preserves the System Key, restarts the Core,
and prints the new password once. Environment/config-managed credentials must
be changed at their source instead.

## Credentials

If configuration does not contain legacy credentials, first start generates a private file under `~/.termux-os/secrets/`. Core never writes credentials to `/sdcard`, logs, HTML, or Package releases.

Legacy `auth.admin_token` and `auth.admin_password` configuration remains readable for migration, but public defaults do not use it.

## Network exposure

Loopback is the safe default. Binding to `0.0.0.0` makes the administration service reachable on available interfaces. Do this only on a trusted network with strong generated credentials and appropriate host firewall rules. Framework provides HTTP and WebSocket transport, not TLS termination; use a trusted local reverse proxy or private tunnel when transport encryption is required.

The Framework controller and independent installer do not inject a DNS library
or require `adb`, `su`, or a resolver-wrapper package. They use the normal
resolver and network behavior of the Termux application process. If a carrier
or VPN exposes unusable IPv6 routes, fix that network condition or use the
device's normal IPv4-capable network path; the Framework does not silently
change process-wide DNS behavior.

## Lifecycle controller

`scripts/framework.sh` is installed as the trusted runtime controller at
`~/framework.sh` in Termux private Home:

```sh
~/framework.sh bootstrap
~/framework.sh start
~/framework.sh status
~/framework.sh logs
~/framework.sh health
~/framework.sh credentials
~/framework.sh stop
```

The Admin Framework Update page invokes this same private controller; it does
not run a second JavaScript update engine. A candidate may contain a runtime
copy of `scripts/framework.sh` for release completeness, but a Web update never
replaces `~/framework.sh`.

The public source-release lifecycle is intentionally separate:

```sh
bash scripts/install.sh
bash scripts/upgrade.sh
bash scripts/upgrade.sh --rollback
bash scripts/uninstall.sh --yes
bash scripts/uninstall.sh --yes --purge
```

For a first install without an existing Framework, obtain the matching public
`scripts/install.sh` and `scripts/installer-lib.sh` from the Framework source
archive, then run `install.sh`. The installer accepts `--version` and
`--repository` overrides for a pinned release, or `--archive --sha256
--version` for an already verified local source archive. The Registry project
must have type `framework`; a Package project cannot satisfy this path.

The independent installer is the trusted redeploy path and may replace
`~/framework.sh` only after verifying the source archive's exact size, SHA-256,
safe single-root extraction, required Framework files, and `package.json`
version. It preserves private configuration, credentials, Installed Root,
models, caches, and runtime observations. A failed bootstrap/start/health check
restores the previous runtime and controller.

Framework update archives are checked, staged on the same filesystem, switched atomically, post-checked, and rolled back automatically on failure. Installed Packages, credentials, models, caches, and persistent data are outside the update boundary.

`deploy.sh` is an optional SSH transport client. It has no built-in host or address:

```sh
DEPLOY_REMOTE=my-phone ./deploy.sh
```
