# Changelog

All notable public changes will be recorded here after the first tagged release.

## Unreleased

- Service identity is instance-scoped end to end. Namespacing only the registration
  was not enough: a Package builds its own runtime paths from its literal service id,
  so two instances read and wrote the same status file while appearing isolated.
  `context.services.id(localId)` now returns the scoped id, and the generated Package
  templates derive `STATUS_FILE` from it instead of a constant.
- Stage service control accepts instance-scoped ids; `@` was previously rejected by the
  route pattern, leaving a Workspace service impossible to start or stop over the API.


- A Workspace now runs **alongside** the released package of the same id instead of
  displacing it. Dev Mount registers under a derived instance key `<package-id>@<slug>`,
  with its own service ids and persist root, and never takes a globally-scoped claim
  (ports, integrations, artifact contracts) — those resolve to exactly one owner, so a
  development copy claiming them would silently redirect the released package's consumers.
  A broken workspace can no longer take the working copy down with it, and both can be
  compared page by page.
- `dev stop` no longer restores anything, because nothing was displaced.
- Dev Runtime control endpoints accept either the instance id or the bare package id when
  a package has exactly one workspace; two workspaces of the same package require `--slug`
  rather than silently acting on whichever came first.
- Replaced the SDK prompt page with **System → Workspace**: one card per package under
  development, listing every page it serves as a direct link. A workspace serves pages at
  `/packages/<id>@<slug>/`, which cannot be guessed, so the Framework states them instead
  of leaving a newcomer to derive them from a naming convention. The Agent-contract API
  (`/api/admin/sdk-guide`) is unchanged.

### Earlier unreleased notes


- Prepared release 0.2.3 with an explicit Package public-file boundary,
  session-bound Terminal tickets, and an explicit LAN exposure confirmation.
- Established Framework Core as an independent Apache-2.0 repository.
- Removed bundled product, engine, model, audio, device, and service implementations.
- Moved Package development to independent repositories and external workspaces.
- Replaced fixed credentials and device defaults with private first-start credentials and loopback-only defaults.
- Added English public documentation, source headers, and publication checks.
- Removed automatic DNS-wrapper injection after validating normal Termux
  application-context HTTPS access without `adb`/`su` dependencies.

## 0.2.2

- Removed automatic DNS-wrapper injection; Framework and the independent
  installer use the normal Termux application resolver without `adb`/`su`.
- Made last-good backup portable to Android app sandboxes by excluding only the
  contributor-only top-level `AGENTS.md` symlink from the rollback archive.
- Standardized software version fields, Registry selections, source refs, and
  user-facing Framework output to the unprefixed form (`0.2.2`). Leading `v`
  versions are rejected rather than normalized.

## 0.2.1

- Added bounded three-stage source resolution: original GitHub tag archive,
  Termux-OS Package Registry fallback, and a manual GitHub Release handoff.
- Added WebUI copy-URL guidance for manual Package and Framework installation.
- Hardened installer downloads with retry-all-errors and exact size/SHA-256
  verification on every attempt.
- Uses the normal Termux application resolver and leaves carrier/VPN routing
  policy outside Framework Core.

## 0.1.10

- Added the public Framework Registry installer, upgrade, rollback, and uninstall path.
- Preserved runtime observations and private state across source-release upgrades.
- Earlier releases accepted more than one source-tag spelling; current
  releases use the unprefixed version format only.

## 0.2.0

- Promoted the public Framework Registry and independent installer closure to the first shared 0.2 release.

## 0.1.1

- Added Package lifecycle cleanup for in-process App runtimes and aligned Admin Overview with the top-level control groups.
- Added unified enable/disable toggles for Applications, Packages, and Package Setting.
