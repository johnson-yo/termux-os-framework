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

Model assets remain under `/sdcard/termux-os/models/<package>/<version>/<target>/`. Shared caches remain under `/sdcard/termux-os/caches/`. A Package installer checks compatibility and downloads or provisions an asset only when it is missing or incompatible. Framework version updates do not redownload models.

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

### Fetching an optional asset after installation

Required assets are provisioned at install; that is what "installed" means.
Assets marked `optional: true` are declared but not fetched, so a Package can
publish several alternatives — a tier the user has not chosen yet, a context for
a device this one is not — without every installation paying for all of them.

`POST /api/assets/<id>/fetch`, or `context.assets.fetch(id)` in-process, obtains
one on demand. The caller supplies only an asset id: the Framework finds the
Package that declares it, selects the variant matching this device, and resolves
the source coordinates from that declaration. A caller that could pass a URL or
a path would make "what is this asset on this machine" a question with two
answers.

A device with no matching variant gets `target_mismatch` listing the variants
that do exist, never a different variant that happens to be present.

## Licensing

Framework Core is Apache-2.0. Extension Packages are separately distributed works and must declare their own license and third-party notices. Core does not bundle engines, models, vendor SDKs, or Extension source, so their licenses do not change the Core license merely because they communicate through public contracts.

Package maintainers remain responsible for confirming redistribution, commercial-use, model-weight, patent, trademark, and attribution terms. This document is an architectural policy, not legal advice.
