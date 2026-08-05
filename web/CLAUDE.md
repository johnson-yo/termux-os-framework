# Web directory contract

This directory contains the Framework-owned administration shell. It uses the HttpOnly browser session and CSRF APIs, stores no credential in browser storage — only named interface preferences such as whether the install prompt was dismissed — and renders only real Core pages plus Package-owned menu entries. Keep it responsive, accessible and dependency-free. User-facing copy is written in Simplified Chinese and translated at runtime. The source string is
the key, the way gettext uses msgid: `web/admin/i18n/<lang>.json` maps source to translation, a
missing entry shows the original, and adding a language is adding one file. Translation happens
inside the shared components — section, text, valueRow, statusRow, actionButton, linkButton — so it
is applied once rather than at each call site. `scripts/extract-ui-strings.mjs` keeps the catalogs
in step with the sources and fails the suite when they fall behind; a string that is concatenated
across lines or assembled in a template cannot be a catalog key, so write it as one literal and wrap
any unit separately. Protocol nouns stay as they are — Framework, Package, Adapter, System Key, SHA-256, GitHub, Registry — so what the panel says still matches the documentation and the logs. Engine output and status values are evidence, not prose: map a known status to a word when displaying it, and pass anything unknown through unchanged rather than hiding it behind a guess.

Package HTML compatibility hides only legacy Framework token fields. An Adapter may mark a
password input with `data-provider-credential` when it must collect a credential belonging to an
external provider. The browser may submit that value once through the shared Browser Session, but
must never persist it; the Adapter backend stores it in private Package configuration and masks it
from read responses.

## Known issue — the login password cannot be changed at all on some devices (reported 2026-08-05, unfixed)

`framework.sh reset-password --password ...` refuses with *credentials are managed by
.../conf/framework.v1.json; change the source configuration instead*, and the HTTP route
answers 409 `credentials_managed_externally`. Both read the same condition: `auth.admin_token`
or `auth.admin_password` present in the config file. A device set up before credentials moved
to the private auth file still carries them there, and every route to change the password is
then closed.

Three separate faults, in the order they should be fixed:

1. **The panel now hands out a command that will be refused.** Switching the password control
   to "copy a command" dropped the check that used to explain a non-editable credential
   source, so the page offers the one thing it knows cannot work. This is a regression
   introduced with the command flow, not a pre-existing bug. Restore the check *before*
   building the command.
2. **The error is a dead end.** "Change the source configuration instead" names a file and
   stops. It should say which keys to remove — `auth.admin_token`, `auth.admin_password` —
   and that removing them hands control back to the private auth file, which already exists.
   An instruction that does not say what to do is a refusal wearing an explanation.
3. **There is no supported migration.** The guard is right for an operator who deliberately
   pinned credentials in config; it is a trap for a device that inherited them. Consider
   `reset-password --adopt`, which moves control to the private file after saying exactly
   what it is about to drop.

This is also why the change-password button appeared permanently disabled in the earlier
report: it was gated on `credentials.editable`, which is false for exactly this condition.
The disabled button and the refused command are one fault seen twice.

## Known issue — the install dialog never closes (reported 2026-08-05, unfixed)

After a package install succeeds the dialog stays open and the confirm button does nothing;
only a page reload clears it.

`install-cancel` is a plain `type="button"` outside any form, so it closes the dialog only
through a JS listener. The confirmation step attaches that listener and its `done()` cleanup
removes it when the user confirms, which is correct for leaving the confirm role. The flow
then finishes by relabelling that button as "done" and attaches nothing, so the control is
given a new role after its only handler was taken away. It is decoration.

The shape to avoid: a control whose label is reassigned without reassigning its behaviour.
Nothing errors, and the button looks exactly as usable as before.

Affects both the package install flow and the Framework update flow, which end the same way.
The page behind the modal is already re-rendered correctly, which is why a reload appears to
fix it and hides how long it has been broken.

Fix by giving the button a close handler when it takes the final role, and assert it in
`scripts/smoke-admin-shell.sh`.

The Packages group exposes `Package Setting` as its operational control page.
Its writes use the authenticated Admin API: port edits are persisted before a
separate Package restart applies them, and disable/enable changes unload or
reload the Package lifecycle without mutating its persistent data.

Installed Package cards expose the same reusable `Open` link styling as
Package Setting cards. `Open` uses a new tab, while `Setting` links to the
corresponding Package Setting card through a stable URL fragment.

The Package Manager also exposes a portrait-friendly `Available` tab. It reads
the Core-owned public catalog, offers a simple refresh and download action,
and sends downloaded archives to the existing local check/install flow.
Files waiting to be installed are shown inside `Installed` as `Pending install`;
the WebUI must show public details before downloading and require the normal
confirmation before installing a remote archive.

Package cards render the Package's `admin.title` with its public `publisher`
suffix when present. The public `name` remains searchable metadata. A valid
HTTPS `release.repository` on GitHub is rendered as an accessible GitHub
source link; the shell never invents a repository URL from a Package ID.

`setup.html` is the entry a freshly installed or freshly updated device shows instead of the login
form. It presents the generated administrator password and System Key once, offers to replace the
password, and asks whether to keep the previous version's settings. The server only answers it for
local requests, so the page must never be reachable from another machine; the same applies to the
post-update review it also renders.

The shell is installable. `manifest.webmanifest` and `sw.js` are served under `/admin`, and every
administration HTML response carries the manifest link and the worker registration, so the entry
point does not depend on which page the user happened to open first. The worker caches the shell
only and never an API response: a control panel showing yesterday's service states is worse than one
that admits it cannot reach the Framework, because the user acts on what it shows. Its cache name
carries the Framework version, or an updated device would keep running the previous release's
JavaScript against the new API. Installation requires a secure context, so it is offered on
`127.0.0.1` and not over a LAN address; the prompt simply does not appear there.

The worker caches nothing it did not ask for. Its first version pre-cached the shell on install,
which happens on the login page, where every script URL redirects back to that page: it stored the
login HTML under `/admin/app.js`, and after signing in the browser was handed HTML where it expected
JavaScript, so the panel never started. Clearing the browser cache did not help, because this store
is separate and the next install poisoned it again. There is no pre-cache, a redirected response is
never stored, and a stored entry whose content type does not match the request is discarded.

Progress and history belong on Status / Logs, not on the page whose job is to act. Package lifecycle
jobs were collected there once already; Framework operation progress and update history stayed on the
update page until they were moved for the same reason, which is that a page asking the user to decide
something should not first make them read records of decisions already made.

The address list shows only addresses something is actually listening on. Listing a LAN address while
bound to loopback sent the user to a page that could not open, and then to look for a network fault
that did not exist.

Changing the bind address or the port restarts the Framework as part of the same action. Leaving the
user to find a restart button afterwards is half a switch. When the port changes the browser follows
to the new address — but only when the port actually changed, and never by copying the configured
port into the current URL, because the port the browser reached the panel on is not necessarily the
port the Framework listens on.

There is one button. Its appearance comes from its variant, never from the container it sits in —
`.button-row button`, `.upload-row button`, `.table-actions button` and `.tabs button` each used to
carry their own rules, so the same action looked different on two pages. `actionButton` and
`linkButton` emit it; containers only lay things out. Panels collapse through `section(..., {
collapsible })` for the same reason: one card implementing its own `<details>` taught the user that
some cards fold and left them guessing which.

Portrait is the primary layout, so buttons are sized by their content and wrap; they are never
stretched to fill a row. A stretched button makes "Update" and "Delete" the same shape, leaving
position as the only way to tell them apart, and one button per row turns three actions into three
screens. The 42px minimum height is what makes a target touchable — width does not need to help.

An action page shows what can be acted on and nothing else. The Framework update page is the current
version, whether a newer one exists, the download and its result, and the way back. Older releases,
candidates whose check failed, and files uploaded weeks ago are not choices; they are residue, and
the recovery card already covers going back. The server prunes them rather than relying on the page
to hide them, because a file nobody can see is still occupying a phone's storage.

Installing is one flow, not a trail of breadcrumbs. Download, check, report, consent, install and
restart happen inside a single dialog that opens the instant the button is pressed — before anything
is known about whether the download will even start, because the first thing the user needs is
confirmation that the command was received. Previously a download ended with a sentence telling
them to go to another tab, find a card, run a check and press install: three interactions to finish
one intention, with a pending state in between that looked like an unfinished chore.

Framework updates and Package installs share that flow. They differ in where the archive comes from,
not in what the user does, so they must not be two screens that drift apart.
