# Security model

## Trust boundaries

- Browser users authenticate with an HttpOnly, SameSite session cookie and CSRF token.
- SDK and automation clients use a bearer token supplied outside source.
- Package code is trusted after release verification and installation; it executes locally with the Termux user's permissions.
- Shared storage is not private. Credentials, browser sessions, and privacy-sensitive temporary audio must not be stored there.
- Installed Package archives, models, and assets are integrity-checked but may have independent licenses and security policies.

## Controls

- random first-start credentials and no source default password;
- loopback-only public configuration;
- authenticated read APIs and authenticated, CSRF-protected browser writes;
- immutable Package versions and SHA-256 release verification;
- local archive installation warns and requires explicit acknowledgement when
  the SHA-256 is not present in the cached verified Registry catalog;
- archive path and symlink checks;
- runtime artifact, architecture, and target preflight;
- process identity validation before sending signals;
- atomic Framework and Package activation with rollback;
- publication checks for secrets, device identities, and workstation paths.

## Non-goals

Core is not a sandbox for malicious Packages, a TLS endpoint, a remote multi-user service, or a license verifier. Install only Packages whose source, release, and maintainer you trust.
