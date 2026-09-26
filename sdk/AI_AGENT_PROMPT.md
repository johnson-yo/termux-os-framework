# Build a Termux-OS Extension Package

You are implementing a feature for the current Termux-OS Framework. Treat the
installed Framework and its SDK as the source of truth; do not rely on an older
`framework/packages/` layout or on historical project notes.

## Feature request

[Describe the feature to build here. If this placeholder is unchanged, ask the
user for the feature request before editing.]

## Start with facts

1. Read every `AGENTS.md` or `CLAUDE.md` that governs the current workspace.
2. Locate the active Framework root. Use `termux-os-sdk` from `PATH`, or use
   `<framework-root>/sdk/termux-os-sdk`.
3. Run `termux-os-sdk context --json` and inspect the current Package, Capability,
   port, runtime, and target contracts before designing the feature.
4. Ask first: am I already in an installed active work tree
   (`~/.termux-os/packages/<id>/versions/<v>/`, see `termux-os-sdk dev status <id> --json` →
   `worktree`)? If so, that directory is the source: edit and commit there. Do not create a host
   repository or use `dev sync` on the phone.
5. Inspect existing Packages first. If the request extends an existing Package,
   modify that Package instead of creating a second one. If it is official, enter Development
   explicitly (`termux-os-sdk dev activate <id>`) only when the user asked for the change.
6. If a new Package is required, choose exactly one primary type:
   `service`, `app`, `adapter`, or `asset`. Use `termux-os-sdk choose` when the
   boundary is not obvious. On a phone, a Web App starts with
   `termux-os-sdk new --type app --template web --dev --id <id> --name "<Name>"`.

## Keep the boundary clean

- On a phone the installed active work tree is the Package's Git repository. Elsewhere, develop in
  the Package's own repository or under `~/termux-os-sources/`. Never add product logic or Package
  source to Framework Core. The retired
  `~/termux-os-dev/packages/` path is report-only and must not be loaded or watched.
- Core owns lifecycle, authentication, administration, port assignment, and SDK
  contracts. Audio, speech, models, vendor runtimes, device bridges, workflows,
  and other product behavior belong in independently licensed Packages.
- Depend on Capability IDs and descriptors, not on a specific provider Package.
- Keep mutable configuration and user data outside the immutable release.
  Models belong under `/sdcard/termux-os/models/`; shared caches belong under
  `/sdcard/termux-os/caches/`.
- Do not put credentials, device addresses, private paths, model blobs, generated
  releases, or private verification evidence in source control.

## Use the current HTTP and administration contracts

- Declare each Package-owned HTTP API in the manifest `ports` array. Treat
  `preferred` as a request, never as a guaranteed port.
- Read assigned ports from `PORT` or `TERMUX_OS_PORT_<ID>` in a supervised
  process, or from `context.ports` in in-process Package code. Bind direct HTTP
  listeners to `TERMUX_OS_PORT_<ID>_HOST` (defaulting to loopback outside Core).
  Never hard-code a port or bind address.
- Authenticate Package-to-Package and trusted third-party HTTP calls with the
  shared System Key. A supervised process receives `TERMUX_OS_SYSTEM_KEY` and
  `TERMUX_OS_FRAMEWORK_URL`; in-process code uses
  `context.auth.systemKey()` and `context.auth.frameworkUrl`. Never copy the key
  into a manifest, config default, static WebUI, log, or release.
- Register one Package-owned page at `/packages/<package-id>/` under the correct
  Core group. Adapters belong under Adapters; use Applications, Services, or
  Packages when those groups match the Package's role.
- Package WebUI uses the Framework Browser Session through
  `/admin/session.js` and `window.TermuxOS.api`. Do not ask for the Framework
  System Key or add a custom login. If an Adapter must collect an external
  provider credential, use a password input marked `data-provider-credential`,
  submit it once to the Adapter backend, keep it out of browser storage and
  browser-built Bearer headers, store it in private Package configuration, and
  mask it from read responses.
- Design the WebUI for a portrait phone first. It must remain usable without
  horizontal scrolling, with readable density, shared card spacing, natural
  button wrapping, and accessible touch targets.

## Implement and prove the result

1. Record the exact requirement and architecture decision before implementation.
   This is a development aid, not a required public file: use `.sdk/` or private
   notes. The published Package should contain `AGENTS.md`, not `CLAUDE.md` or
   `DEVELOPMENT.md`.
2. Generate or inspect the Package with the current SDK, then declare manifest
   runtime, targets, components, entry points, integrations, assets, menu, ports,
   and verification hooks as applicable.
3. Add a fast isolated `test/self-test.mjs`. Use fixtures and temporary
   directories; do not require a real device, network account, model, or user
   data.
4. Standard order on the phone: inspect/status → locate the active work tree → `dev activate` if the
   Package is official and the user asked for a change → `dev start` → edit/test → Chrome and
   `verify-device --dev` → `git commit`. Dev Runtime reloads that work tree; it is not release
   evidence. (`dev sync` exists only for a source repository on another machine.)
5. Run:

   ```sh
   termux-os-sdk doctor <package-id>
   termux-os-sdk test <package-id>
   termux-os-sdk release <package-id>
   termux-os-sdk install <absolute-release.tar.gz>
   termux-os-sdk verify-device <package-id>
   termux-os-sdk handoff <package-id>
   ```

6. Release only through the deterministic Source → Release → verify → target
   check → immutable Installed Root flow. Edit an installed version only while it is in
   Development; restore, update, and uninstall refuse to destroy its local history unless told to
   back it up (`--preserve-development`) or discard it (`--force-discard`).
7. Release readiness comes from the self-test, doctor, immutable release
   verification, and Device Verify. User review is external feedback, not a
   Package feature, page, document, endpoint, or runtime status.
8. If an AI Agent materially contributed, optionally note the tool and scope in
   `NOTICE.md`; this is a disclosure reference, not an approval gate. Never put
   private prompts, credentials, device identities, or internal notes there.
9. Report exactly what changed, the commands and results that prove it, the
   installed version and SHA-256 when applicable, and any unresolved limitation.
   Do not claim success that the checks did not establish.

Make reasonable in-scope decisions and continue autonomously. Stop and ask only
when a missing choice would materially change the feature boundary, user data,
licensing, security, or external behavior.
