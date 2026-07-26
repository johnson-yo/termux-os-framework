# Contributing

Thank you for improving `termux-os-framework`.

## Before changing Core

Confirm that the requested behavior belongs to Framework Core. Product behavior, engines, models, hardware bridges, and vendor integrations belong in Extension Packages. Prefer deleting a Core special case over adding another one.

## Development workflow

1. Read `CLAUDE.md` and the nearest directory-level instructions.
2. Keep the change focused and preserve public contracts unless the change is explicitly versioned.
3. Add or update the smallest test that would catch a regression.
4. Run `npm test` and `npm run check:public`.
5. Explain compatibility, storage, security, and migration effects in the change description.

Do not commit generated releases, secrets, device addresses, workstation paths, model files, or private test evidence.

## Contributions and licensing

Unless explicitly marked otherwise in writing, a contribution intentionally submitted for inclusion is provided under Apache-2.0, as described by section 5 of the license. The contributor must have the right to submit it.

Third-party code or data requires prior license review, preserved notices, and a clear reason it belongs in Core. Engines and models normally do not belong in Core at all.
