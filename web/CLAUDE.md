# Web directory contract

This directory contains the Framework-owned administration shell. It uses the HttpOnly browser session and CSRF APIs, stores no long-lived credential in browser storage, and renders only real Core pages plus Package-owned menu entries. Keep it responsive, accessible, dependency-free, and English by default.

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
