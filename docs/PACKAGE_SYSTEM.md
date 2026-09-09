# Package system

## Atomic extension types

- **service**: a supervised long-running process or stateful worker
- **app**: a user workflow that combines Capabilities without naming providers
- **adapter**: a bridge to an application, device, engine, or external API
- **asset**: immutable data such as a model or optimized graph, with no process

If a change extends an existing Package, change that Package instead of creating another one.

## Manifest contract

Every Package has `termux-os.package.json` and declares identity, version, type, entry points, components, Capabilities, runtime requirements, targets, menus, and verification hooks as applicable.

Install-time human-facing requirements may be declared in
`public_metadata.dependencies` and `public_metadata.security`. They are shown
before download and must describe dependencies, permissions, network exposure,
and data access without containing credentials or device-specific information.

Public attribution is declared with `publisher`, `license`, and the optional
`release` metadata object. `release.repository` is the canonical source URL;
the Admin Package catalog may expose it as a provider-specific source link.
These fields identify public source ownership only. Credentials, device
addresses, private paths, mutable state, and verification evidence never
belong in a manifest or Release.

Package identity is `id + version + target`. Declared bundled artifacts must exist in the release. Device mismatches and missing external requirements are rejected before Installed Root changes.

## Lifecycle

```text
independent source repository
  -> doctor and Package self-test
  -> deterministic tar + SHA-256
  -> verify and target preflight
  -> immutable installed version
  -> atomic active.json switch
  -> device verification
  -> handoff with exact evidence and known issues
```

The local Package Manager may also receive a pinned `source_tar` from the
public Package Registry. A GitHub Package first tries its catalog-derived
original tag archive, then the Termux-OS Registry conversion, and finally
offers a manual Release-page download if both paths fail. A GitHub-generated
source archive can use an upstream top-level directory name rather than the
Framework Package ID; verification still requires exactly one safe top-level
directory and a valid Manifest, then installation normalizes that extraction
root to the Manifest ID. The Registry metadata and streamed SHA-256 are
checked before the archive enters local preflight. Remote downloads never
bypass the normal explicit Install step.

The public catalog lists only versions and files that have passed Registry
verification. It may expose an `official` array with multiple maintainer IDs;
the Framework may map any non-empty array to the compact public label
`Official` while retaining the individual IDs as metadata.

Rollback changes only the active pointer. Uninstall removes Package activation but preserves separately managed user data and immutable shared assets unless an explicit, safe cleanup contract says otherwise.

An `app` Package may own an in-process runtime without registering a Stage
Service. Such a Package must register every close/cleanup action through
`context.lifecycle.register()`. Package Setting `restart` and `disable` await
those cleanups before removing routes and port ownership; `enable` then loads
the Package again and creates a fresh runtime state.

## Models and caches

Model assets remain under `/sdcard/termux-os/models/<package>/<version>/<target>/`. Shared caches remain under `/sdcard/termux-os/caches/`. An Asset Package declares and registers its Assets; the Package installer may provision required payloads during installation and may skip `optional` payloads. `optional` describes install-time provisioning only. After registration, a replaceable Manager owns payload download, verification, storage, update, and deletion. Framework version updates do not redownload models and do not take ownership of Manager policy.

### A payload's target is not the Package's target

`targets[]` says where this *code* can run, and a Release is identified by
id + version + target, so it carries exactly one. A precompiled accelerator
context is bound to a DSP architecture and a runtime version instead: it is
useless on any other device, and it fails at load time rather than at install
time. Expressing that with the Package target alone forces one Package per
hardware generation, which is a claim the Package cannot honour — nothing in it
is device-specific, because a remote payload ships only coordinates.

An entry in `assets.provides[]` may therefore declare its own `target`, using
the same fields as `targets[]`. The same asset id may appear several times as
long as every one of those entries declares a distinct target; a repeated id
with no target is rejected, because "works anywhere" and "works only on V73"
under one name has no resolution order that means anything.

The store path uses the payload's own target, so two hardware variants can never
land in one directory. That is a Framework guarantee rather than a convention:
an EPContext wrapper references its context binary by relative name, so a
mismatched pair opens successfully and only then fails inside the runtime.

### Fetching an Asset after installation

Required assets are normally provisioned at install; `optional: true` means the
installer may leave the payload absent so a Package can publish alternatives
without every installation paying for all of them. It does not mean that a
Manager is forbidden to fetch, update, verify, or delete the Asset later.

A Manager may request a registered Asset payload using its own catalog and
source adapter. It may call Core's generic transfer primitives, which should
accept an explicit, already-resolved transfer specification and destination
within the allowed store, or it may implement source access itself. Core must
not require the caller to be an Asset Package, hide the source behind an
`optional` gate, or encode a particular upstream such as Hugging Face.

A device with no matching variant gets `target_mismatch` listing the variants
that do exist, never a different variant that happens to be present.

### Raw payload primitives, purge, and consumer declarations

Core may provide generic raw-payload primitives. A `tar.gz` archive with
`termux-os.asset-archive.json` and `payload/<asset>/<file>` entries is accepted
only after path, type, size, and sha256 checks. Identical payloads may be reused;
conflicting bytes may be rejected as a technical integrity invariant. The
Manager owns the import/update/delete decision and user confirmation. A purge
removes only the requested payload path inside the shared Asset Store, preserves
the Asset declaration/registration, and must not be restricted merely because
the payload arrived with its Asset Package or because a consumer declaration
exists.

Installed Package versions may place empty declaration files at
`.models/<owner>/<repository>` in their active version root. `GET /api/packages/model-declarations` returns
the current declarations and explicit malformed-package/path errors. Core does
not write a consumer ledger, infer identities from Package names, or interpret
these declarations as runtime readiness.

## Licensing

Framework Core is Apache-2.0. Extension Packages are separately distributed works and must declare their own license and third-party notices. Core does not bundle engines, models, vendor SDKs, or Extension source, so their licenses do not change the Core license merely because they communicate through public contracts.

Package maintainers remain responsible for confirming redistribution, commercial-use, model-weight, patent, trademark, and attribution terms. This document is an architectural policy, not legal advice.
