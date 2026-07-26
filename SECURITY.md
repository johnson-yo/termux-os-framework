# Security Policy

## Supported code

Security fixes target the current `main` branch until tagged releases are published. Older local snapshots are not supported.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/johnson-yo/termux-os-framework/security/advisories/new)
when available. If that channel is unavailable, contact the maintainer through
a private channel. Do not include credentials, private paths, device
identifiers, or exploit details in a public issue. Include:

- the affected commit or release;
- the trust boundary and impact;
- minimal reproduction steps;
- whether credentials or user data may have been exposed;
- a suggested mitigation, if known.

The maintainer should acknowledge the report, reproduce it in isolation, prepare a fix, and coordinate disclosure after users have a safe upgrade path.

## Credential rotation

Framework credentials are stored in `~/.termux-os/secrets/framework-auth.v1.json`. To rotate them, stop Framework, move that file to a private backup, start Framework to generate a new file, and update authorized SDK clients. Never copy the file into source or shared storage.
