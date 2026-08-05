# Package contracts

## Required files

- `termux-os.package.json`
- `README.md`
- `LICENSE`
- `NOTICE.md`
- `AGENTS.md` (contributor/runtime instructions; use this name in published Packages)
- declared backend and WebUI entry points
- `test/self-test.mjs`
- declared verification files

## Manifest rules

- Identity, version, type, compatibility, components, and entry points must validate.
- Declared runtime artifacts must exist inside the release.
- Native artifacts must match the selected target and resolve bundled libraries from package-relative paths.
- External requirements must be explicit and are checked before installation.
- A Package menu may expose only its own `/packages/<id>/` page under allowed Core parents, including the Packages and Adapters groups.
- Capability consumers name a Capability; they do not hard-code its provider.
- HTTP APIs are declared in the manifest `ports` array; the Core assigns a stable Package-owned port and rejects collisions.
- A Package WebUI uses `/admin/session.js` and `window.TermuxOS.api`; it never asks for the
  Framework System Key or implements its own login. An Adapter may ask for an external provider's
  credential in a password input marked `data-provider-credential`. The browser submits it once
  through the Browser Session, never writes it to browser storage, and never builds a custom Bearer
  request. The Adapter backend stores it in private Package configuration and masks it from every
  read response.
- Public install metadata may declare `public_metadata.dependencies` and
  `public_metadata.security`; keep it descriptive, reviewable, and free of secrets.

## Runtime rules

- Configuration and durable data stay outside immutable release directories.
- Status distinguishes desired state, process state, health, and last activity.
- Package routes are namespaced under `/api/packages/<id>/`.
- A Dev Runtime page is instance-scoped as `<id>@<workspace-slug>` and must call the matching
  `/api/packages/<instance-id>/` route. SDK-generated WebUI derives this value from the current
  `/packages/<instance-id>/` pathname instead of hard-coding the release ID.
- An interactive Package may register `context.websockets.register('/path', handler)`.
  The Core authenticates the Browser Session and dispatches the upgrade on the same
  `/api/packages/<id>/path` origin; the handler receives the client socket and
  optional upgrade head. This keeps a loopback Package service off the LAN.
- Package services receive their assigned `PORT` values and the current `TERMUX_OS_SYSTEM_KEY`; in-process code uses `context.ports` and `context.auth.systemKey()`.
- Package services use `TERMUX_OS_FRAMEWORK_URL` for Core API calls; in-process code uses `context.auth.frameworkUrl`.
- Failures return structured errors and never claim readiness when an asset, service, or target is unavailable.
- WebUI layout is portrait-phone-first, avoids horizontal scrolling, and keeps controls usable at touch size.

## License rules

Every Package chooses and ships its own license and notices. Do not assume Framework Core's Apache-2.0 license covers an engine, model, SDK, dataset, or vendor binary.
