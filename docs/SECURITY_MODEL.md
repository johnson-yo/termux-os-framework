# Security model

## Trust boundaries

- Browser users authenticate with an HttpOnly, SameSite session cookie and CSRF token.
- SDK and automation clients use a bearer token supplied outside source.
- Package code is trusted after release verification and installation; it executes locally with the Termux user's permissions.
- Shared storage is not private. Credentials, browser sessions, and privacy-sensitive temporary audio must not be stored there.
- Installed Package archives, models, and assets are integrity-checked but may have independent licenses and security policies.

## Privilege boundary

- Framework Core, its lifecycle controller, and its installer are designed to run as the ordinary Termux application user. UID 0 is not a runtime prerequisite.
- Core never silently elevates itself with `su` or `run-as`, and it does not treat root as an assumed device capability. SDK `adb` or SSH transports are explicit host-side connection choices, not Core privilege escalation.
- A Package that genuinely needs a privileged capability owns that integration, its permission/availability declaration, and its non-privileged fallback. Core only coordinates the Package boundary; it does not absorb the privileged behavior.
- Device-specific boot or recovery shims, if used on a development phone, are deployment tooling outside the Framework release contract and must not turn root into a requirement for ordinary users.

## Controls

- random first-start credentials and no source default password;
- loopback-only public configuration;
- authenticated read APIs and authenticated, CSRF-protected browser writes;
- immutable Package versions and SHA-256 release verification;
- local archive installation requires an explicit SHA-256 acknowledgement when
  its digest is not already in the cached verified catalog and defaults to a
  local-only dependency path; the acknowledgement does not authorize a
  Registry lookup or download;
- Registry dependency supplementation is a separate explicit mode, never an
  implicit fallback from a local archive;
- active dirty Package worktrees require a separate explicit choice: the WebUI
  may save a complete backup or deliberately discard the worktree, while the
  CLI exposes the equivalent `--preserve-dirty` / `--force-dirty` options;
  neither choice is inferred from the SHA-256 acknowledgement;
- dirty-worktree backups are written to private Termux storage with a digest
  sidecar before the active version is replaced;
- archive path and symlink checks;
- runtime artifact, architecture, and target preflight;
- process identity validation before sending signals;
- atomic Framework and Package activation with rollback;
- publication checks for secrets, device identities, and workstation paths.

## Non-goals

Core is not a sandbox for malicious Packages, a TLS endpoint, a remote multi-user service, or a license verifier. Install only Packages whose source, release, and maintainer you trust.
