# docs directory contract

This directory contains public, normative English documentation for Framework Core.

- `ARCHITECTURE.md`: boundaries and component relationships
- `CONFIGURATION.md`: configuration, storage, credentials, and deployment
- `PACKAGE_SYSTEM.md`: Package identity, lifecycle, extension types, and licensing
- `SECURITY_MODEL.md`: trust boundaries and controls
- `DEVELOPMENT.md`: local development and verification
- `HISTORY.md`: concise public evolution
- `../scripts/public-files.txt`: explicit public-source allowlist

`MAINTAINER_HANDOFF.md` is a local maintainer record and is deliberately
excluded from the public source tree. Keep it in the local development tree;
never add it to the public allowlist.

Do not store device logs, private benchmarks, credentials, local paths, operational IP addresses, or product-specific implementation plans here. Those belong in private evidence storage or the responsible Extension Package repository.
