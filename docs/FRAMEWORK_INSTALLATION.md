# Framework installation and source releases

Framework Core is distributed as a GitHub source archive and admitted to the
Package Registry under the `framework` project type. The source archive is the
official repository tag archive; it is not a deterministic SDK Package release
and it is not a bundled application or model.

## Fresh installation

The independent installer can run before Framework exists. It retrieves the
latest verified `framework` entry, rechecks the Registry metadata, downloads
the `source_tar`, verifies its exact byte count and SHA-256, extracts one safe
top-level directory, and validates the Framework package version before
deployment:

```sh
bash scripts/install.sh
```

Pin a release when the operator has an explicit reason:

```sh
bash scripts/install.sh \
  --repository johnson-yo/termux-os-framework \
  --version 0.2.3
```

For a bootstrap machine without these scripts already available, obtain the
matching public `scripts/install.sh` and `scripts/installer-lib.sh` from the
exact source tag, then run the installer. A local archive may be supplied only
with its intended version and expected hash:

```sh
bash scripts/install.sh \
  --archive /path/to/framework-source.tar.gz \
  --version 0.2.3 \
  --sha256 <64-hex-sha256>
```

The installer creates the private runtime under `~/.termux-os/framework/` and
the controller at `~/framework.sh`. Configuration and persistent Framework
state default to `/sdcard/termux-os/framework/`; credentials remain in Termux
private Home. The installer generates the local runtime identity and release
metadata because a raw GitHub source archive does not contain device-specific
deployment state.

## Upgrade, rollback, and uninstall

```sh
bash scripts/upgrade.sh
bash scripts/upgrade.sh --rollback
bash scripts/uninstall.sh --yes
bash scripts/uninstall.sh --yes --purge
```

An upgrade backs up the healthy current runtime, stops Framework, installs the
verified candidate, preserves runtime observations and private state, then
starts and health-checks the new version. A failed activation restores the
previous runtime and controller. `--rollback` restores the controller's
last-good archive. The default uninstall removes only the runtime and
controller; it preserves configuration, credentials, Installed Packages,
models, and caches. `--purge` additionally removes Framework configuration,
credentials, and install state, but never removes Installed Packages, models,
or caches.

The browser Admin update action uses a bounded three-stage source path after
the catalog has been refreshed:

1. It probes the original GitHub tag archive with a short timeout and, when
   reachable, downloads that source archive.
2. If GitHub is unavailable or its response fails the catalog size/SHA-256
   gate, it downloads the same pinned file through the Termux-OS Package
   Registry.
3. If both paths fail, the UI shows the GitHub Release page with a Copy URL
   action. The user can download the archive manually, transfer it to the
   device, and use Update files → Upload update file. The normal preflight,
   hash check, explicit confirmation, upgrade, health check, and rollback
   contract still applies.

The independent installer follows the same first-two-stage order when the
Registry has supplied the expected size and SHA-256. The Registry's pinned
hash is the official admission gate; Framework does not add a second Package
release-signature system. If neither download works, it prints the Release
URL and the exact `--archive --version --sha256` command needed for a manual
install or upgrade. The browser process and installer never install an
archive whose size and pinned hash do not match.

## Public source boundary

The public tree is the exact output of `scripts/export-public-tree.mjs` from
the allowlist in `scripts/public-files.txt`. Local-only files are not deleted;
they are simply absent from the exported tree. The list intentionally includes
the SDK runtime, schemas, templates, generic examples, and public docs while
excluding maintainer handoffs, device evidence, generated `.sdk/` state, model
blobs, credentials, and workstation-specific paths.

Before creating or updating the public repository:

```sh
npm test
npm run check:public
npm run public:export
npm run public:check
```

Only `tmp/public-tree/` is committed to the public GitHub repository. The
local Framework source tree remains the development workspace and may contain
private material governed by its local maintainer rules.
