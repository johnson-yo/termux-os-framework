# Changelog

All notable public changes will be recorded here after the first tagged release.

## 0.2.33

- **The release workflow keeps every file it produces outside the checkout.** Capturing the
  builder's output with a redirection created that file before the builder ran, so the command
  invoking the builder was itself what made the tree dirty. The step now also asserts the
  checkout is still clean after building.

## 0.2.32

- **The standard release workflow no longer dirties the tree it is about to publish.** It fetched
  the shared builder into the repository, and that untracked file made the work tree dirty, so the
  builder refused to publish it. The dirty-tree guard runs before the fetch, so nothing caught it
  until the build failed. The builder is fetched outside the checkout.

## 0.2.31

- **A Package is one thing, and Git says whether you have edited it.** Development used to mount a
  workspace copy as a second instance keyed `<id>@<slug>`, running beside the released Package with
  its own data, its own URL and suffixed service ids. Two instances meant two answers to every
  question about one Package, and a stored "is dev" flag that could be cleared while the edit
  survived. There is now one installed copy: `release` or `dev` is read from its work tree, and a
  committed change that leaves the tree clean is still reported as diverged from the release.
- **`dev` only watches.** `dev start` begins auto-reloading the installed Package in place and
  `dev stop` ends it; neither changes what the work tree says. Watching a clean Package leaves it
  released, and stopping the watcher on an edited one leaves it edited. `--workspace`, `--slug`,
  `--use-live-data` and `data_mode` are rejected with the reason rather than ignored.
- **Installing keeps the original archive, so there is a way back.** The verified bytes are stored
  beside `versions/` and `config/`, and `package-manager restore <id>` unpacks them after checking
  the recorded SHA-256. Configuration, persisted data and shared assets live outside the work tree
  and are untouched. An update over an edited Package is refused instead of overwriting it.
- **One builder produces every package archive.** `termux-os-sdk release` and the standard GitHub
  Actions workflow both call `scripts/build-package-asset.sh`, which clones depth-1 from the source
  repository: the archive carries a real shallow history on a named branch with its origin intact,
  so the installed Package can be inspected, committed to and pushed back from the device.
- **The catalog can install a Release asset.** `release_asset` is accepted and preferred over the
  GitHub-generated source archive; a Package that only publishes `source_tar` still installs.
- **The SDK keeps its notes out of the Package.** Handoff, verify records and dev sessions moved
  beside the Package instead of inside it, so running them no longer reports a clean Package as
  edited. The four bundled examples pass `doctor` again, and the test suite now checks them.

## 0.2.30

- **An installed Package's Update button works too.** It was disabled for any Package whose
  manifest omits the optional `release.repository`, because both "is there a newer version" and
  "which version do I install" joined the catalog on that free-text URL. A Package that never
  filled it in simply had a permanently greyed button and nothing anywhere said why. Both now
  resolve the catalog entry through one shared lookup, keyed on the package id — the identity this
  system uses everywhere else.

## 0.2.29

- **An installed Package can be updated again.** The Install button was disabled whenever that
  package id was installed at all, so a device on 0.18.0 saw a card reading "latest verified
  0.19.0" above a greyed-out "installed 0.18.0" button — every word on the card true, and no way
  to upgrade.
  It now compares versions: the same version has nothing to do, a newer one offers an update, an
  older one offers a downgrade.
- **A Package's declared dependencies are shown.** The panel read only `public_metadata`, so a
  Package declaring five capabilities and eleven dependencies was described as having declared
  nothing. The catalog index carries those facts, extracted from the archive itself.

## 0.2.28

- **`POST /api/assets/<id>/provider` installs the Package that supplies a model.** A consumer's
  page can now complete its own setup: it names the asset it wants, and the catalog answers which
  Package provides it. A page that had to name the Package instead would be copying "who supplies
  this model" somewhere it cannot keep correct. Several providers are not guessed between.

## 0.2.27

- **Asset Packages no longer appear under Packages or Package settings.** A model asset belongs to
  whichever Package needs it and is managed from that Package's own page. Listing them here
  presented a set of entries nobody chose and nobody can judge whether it is safe to remove.
- **`DELETE /api/assets/<id>/payload`** removes a payload that was fetched on demand, so the
  Package that needs a model can also give the space back. An asset that arrived with its Package
  is refused: removing it would make "installed" untrue.
- Fetching an asset now requires write permission. It writes hundreds of megabytes; it was
  reachable with read.

## 0.2.26

- **A missing required package dependency is now actually installed with its target.** The plan
  listed each one with a resolved download coordinate, and the install step downloaded only the
  packages derived from capability dependencies — so a package could install "successfully" while
  the dependencies it declared were never fetched. The list existed, was printed, and had no
  executor.
- **A module self-test no longer hijacks another module's run.** Six guards checked only for the
  `--self-test` flag, so importing any of them during another module's self-test ran their block
  and exited the process first. The importing module's assertions never executed, and the output
  looked entirely normal — it was simply somebody else's.

## 0.2.25

- **Two catalog projects claiming one package id resolve to nothing rather than to a guess.**
  Taking the first match silently installed a superseded project's older version while both sides
  looked correct. A duplicate identity is the catalog's error, not a choice for the caller.

## 0.2.24

- **A dependency no longer resolves to a version that has nothing to install.** One repository can
  host both package archives and the model files those packages point at, and a remote model file
  is registered under its immutable commit sha — so a project's newest "version" is routinely a
  40-character sha carrying no archive. Resolving a dependency to it reported the package as
  missing from the catalog while every installable version sat in the same list. Resolution now
  takes the newest version that actually carries an archive.

## 0.2.23

- **The installable list shows what a person installs.** It used to show everything in the
  catalog except the Framework, and half of that could not be installed at all — several asset
  entries exist only so the download proxy recognises an upstream file's coordinates and carry no
  archive, so they appeared as cards saying there was nothing to install. The rest are model
  assets, which arrive as a dependency of whatever needs them; nobody sets out to install a set of
  weights. The list is now an allowlist of adapter, app and service.
- **An installed package no longer offers an enabled Install button.** It reads its installed
  version instead. Pressing the old button reinstalled the same version and stopped the package on
  the way, which is not what an enabled button promises.
- **The install dialog can always be closed.** Its single button is renamed through Cancel, Close
  and Done, and the consent step removed its own listener when it finished — so the button renamed
  to Done had no handler and only a page reload escaped it.
- **A pinned login password says what pins it.** When credentials come from configuration or the
  environment, the panel names the keys responsible and what removing them restores, instead of
  handing over a command it knows will be rejected.

## 0.2.22

- **A Package can carry every hardware version of a model, and the device picks its own.**
  A precompiled accelerator context is bound to one DSP architecture, and until now the only
  way to say so was to publish a separate Package per generation — a claim that was never
  true, since nothing inside such a Package is device-specific. An asset declaration now
  carries its own target, independent of where the Package's code runs. The store path uses
  it, so two variants can never land in one directory and be opened as a mismatched pair.
- **An optional asset can be fetched after installation**, through
  `POST /api/assets/<id>/fetch` or `context.assets.fetch(id)`. A model chosen after
  installation should be downloaded then, not at install time alongside every alternative
  the user did not choose. The caller names only an asset id: the Framework finds the
  Package that declares it and reads the coordinates from there.
- A device with no matching variant is told which variants do exist and what the device
  reports itself to be, instead of being given a substitute that would fail at load time.

## 0.2.21

- The login password is changed by a command you paste into Termux, not by the panel.
  Rewriting the credential file voids every session including the one making the request,
  so a panel doing it pulls the floor out from under itself — any step that goes wrong
  removes exactly the entrance needed to fix it. Type the password, copy the command, paste
  it. The command starts with a space, which keeps it out of Termux's shell history.
- A service can name the app that owns it, and such workers no longer appear under Services.
  They are that app's implementation detail, started and stopped from its own page; listing
  them asked the user to manage something they never meant to, with two sets of controls
  doing one thing. They stay supervised, and the page says how many there are and where
  they live.
- Packages can restart a worker they registered themselves. Configuration is read once at
  start, so leaving the restart to the user turns a necessary step into a forgettable one.

## 0.2.20

- **A missing capability now names the package that supplies it.** A capability
  dependency deliberately names an ability rather than a package, so a consumer never
  hard-codes its provider; the cost was that resolution ended at "no provider registered",
  which is true and useless. The Registry index closes the gap, and confirming an install
  fetches the required dependencies and installs them in one job, dependencies first. The
  sequence stops at the first failure — a target installed without what it depends on looks
  like success and is worse than an outright failure. Optional dependencies are listed and
  never installed.
- **Capability dependencies are read from the field packages actually use.** Nine packages
  declare `capabilities.requires[].id`; the ladder only ever read
  `integrations.requires[].capability`, which one uses. Every declared capability dependency
  was therefore invisible to the check meant to enforce it — the manifest validated, the
  field read back, and nothing consulted it.
- Picks the right archive when one registered version carries several, which is how an
  asset ships a portable graph alongside one compiled context per DSP architecture. Taking
  the first match installs a variant built for other hardware.
- The login password is one visible field with no confirmation to mistype. Re-typing is a
  patch for masked input; with the value shown it protects nothing and adds a way to lock
  yourself out. When the control is unavailable the page says why instead of presenting a
  dead button — credentials managed outside the Framework and a read-only session used to
  look identical.
- Runtime detail moved to the foot of Overview. That page had no action on it, so it split
  "what is happening" from "why" across two navigations and offered nothing at the end of
  the second.

## 0.2.19

### Core mechanisms

- **Dependencies became a ladder instead of a boolean.** A package's requirements now resolve
  through missing -> installed -> configured -> reachable -> healthy -> compatible -> ready, so
  "not ready" says which rung it stopped on. Service start, uninstall and doctor consult it, and
  an install whose dependencies exist nowhere is refused up front rather than at first use. The
  install preflight asks whether the gaps are *obtainable*, not whether they are already met —
  otherwise nothing with a dependency could ever be installed first.
- **A state bus, alongside capabilities and feeds.** A capability answers who can perform an
  ability and may have several providers; a state answers what a fact is right now and therefore
  has exactly one writer, no binding and no persistence. States are declared by a package,
  written in-process through `context.states` or over `/api/states` by an independent service,
  and revoked the moment the package unloads — a fact with no informant is not a fact. Each
  reports whether it is still `live`, and a stale value is served with the reason instead of
  being hidden. System -> States shows who informs whom.
- **Assets can be fetched from where they already live.** An `assets.provides[].source` lists
  files with a repository, an immutable revision and a SHA-256 each, so a large model is streamed
  from its upstream home instead of being repackaged into an archive that duplicates every byte.
  The hash is computed while streaming, which is what catches a truncated resume: a partial
  download can otherwise look complete and report a plausible length.
- **An asset may be offered without being fetched.** `optional: true` keeps a payload out of the
  install and behind an explicit action, so a device does not download a variant it will never
  load — one package offering two decoder tiers no longer costs every device both.
- **The device profile is measured rather than assumed.** `htp` and `arch`/`qnn` were placeholders
  that no code ever set, so every device reported "unknown" and every hardware-targeted package
  resolved to needs-force; target matching was decorative. The DSP architecture now comes from a
  published SoC table and the accelerator runtime version is read from the binary that will
  actually be loaded. An unrecognised SoC still reports unknown: guessing here replaces "refuses
  to install" with "installs and fails on every execution". `GET /api/system/device` exposes it,
  because a rejected install is unanswerable without seeing your own side of the comparison.
- Fixed a development dependency override that reported success and did nothing. The start gate
  reads a snapshot taken when the workspace was mounted, and flipping the flag left that copy
  untouched; the same lookup also resolved the released package instead of the workspace instance.
- SDK-generated WebUI derives its package id from the active path instead of a constant, so a
  workspace page no longer controls the installed package by accident.
- An adapter may collect an external provider's credential through a marked password field that
  is submitted once to its backend and never stored in the browser. Framework credentials remain
  in the Browser Session; doctor now distinguishes the two rather than rejecting both.

### Control centre and workspace

- The control center is now operable without a shell. Changing the bind address is a
  toggle under System -> Administration, and because a bind only takes effect at startup
  it sits next to a Restart button; an update blocked by an active Dev Runtime offers to
  stop those mounts in place. Both previously ended in an instruction to run a command,
  which is not a usable answer for someone who never opens Termux.
- Workspace lists every project under the workspace root, not only the mounted ones. A
  workspace is a directory on disk and mounting is one of its properties, so listing only
  mounts meant a project the user had just created was invisible until they ran `ls`.
  Projects can be created from a template, packed to a browser download, mounted and
  deleted from the page.
- Workspace moved into the Packages group, and the Developer resources page — one
  external link — folded into the Workspace header as "Share your App".
- A workspace instance is allocated its own ports again. Ports are keyed by package id
  and an instance has its own id, so the allocator already avoided the released package's
  port; denying them outright meant any package that needs a port could not run in a
  workspace at all, failing with "did not assign the HTTP port". Integrations and
  artifact contracts remain off limits: those resolve by capability name to one owner.
- Installed and Available now resolve package identity the same way. The manifest records
  a full repository URL while the Registry uses `owner/repo`, so comparing them directly
  never matched and official packages showed their publisher instead.
- Installed cards carry one row of six fixed actions -- Open, Setting, Update, Dev,
  Rollback, Uninstall -- with unavailable ones disabled in place rather than removed, so
  a button never moves. Update upgrades from the Registry without leaving the page; Dev
  copies the installed version into a workspace and mounts it.
- Download on an Available card no longer waits for Details to be opened. The value of
  declared permissions is that they can be read, not that a click is forced; they now sit
  behind a disclosure, which also states plainly when a package declared nothing.
- The catalog refresh became a panel-level action. Framework Update and Packages already
  shared one cached catalog, so leaving the only refresh inside a tab meant the other page
  could never see fresh data. The framework itself is filtered out of the installable list.
- Package-owned pages open in a new tab, and Recent operations appears once, under
  Status -> Logs, instead of on every package page.

- Workspace data no longer lands on shared storage. A Package under development may write
  audio or images, and anything under `/sdcard` is indexed by the Android media scanner and
  appears in the user's gallery; development output must not be able to pollute the device
  that way. It now lives under the Framework's private `.runtime/dev-data`, which the
  installer preserves across updates.
- The Workspace page no longer repeats the page heading in a card of its own — the Shell
  already renders the title and its registry description — and its cards use the shared
  `valueRow` layout instead of a bespoke grid, so they read like every other page.

- Fixed the Workspace page rendering "No workspace mounted" while the API returned the
  mount: it read `api()`, which resolves to a `Response`, instead of `apiData()`, which
  parses it. The API was right and the screen was wrong, so checking the API alone could
  not find it; the smoke now asserts the rendered view and the helper it uses.

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
