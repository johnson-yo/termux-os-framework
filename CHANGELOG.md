# Changelog

All notable public changes will be recorded here after the first tagged release.

## Unreleased

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
