# Web directory contract

This directory contains the Framework-owned administration shell. It uses the HttpOnly browser session and CSRF APIs, stores no credential in browser storage — only named interface preferences such as whether the install prompt was dismissed — and renders only real Core pages plus Package-owned menu entries. Keep it responsive, accessible and dependency-free. User-facing copy is written in Simplified Chinese and translated at runtime. The source string is
the key, the way gettext uses msgid: `web/admin/i18n/<lang>.json` maps source to translation, a
missing entry shows the original, and adding a language is adding one file. Translation happens
inside the shared components — section, text, valueRow, statusRow, actionButton, linkButton — so it
is applied once rather than at each call site. `scripts/extract-ui-strings.mjs` keeps the catalogs
in step with the sources and fails the suite when they fall behind; a string that is concatenated
across lines or assembled in a template cannot be a catalog key, so write it as one literal and wrap
any unit separately. Protocol nouns stay as they are — Framework, Package, Adapter, System Key, SHA-256, GitHub, Registry — so what the panel says still matches the documentation and the logs. Engine output and status values are evidence, not prose: map a known status to a word when displaying it, and pass anything unknown through unchanged rather than hiding it behind a guess.

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
