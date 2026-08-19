# System module contract

System modules own Framework authentication, browser sessions, CSRF, administration, jobs, access reporting, observations, Package control and Package Setting state, the public Package Registry client, Framework updates, and the Core-owned Dev viewport marker. Package Setting state is private persistent metadata: it may change Package port assignments/visibility and enablement without changing an immutable Release. Dev marker output is injected only for watched Dev HTML and never for an Installed Release.

Child Node processes must use the shared runtime resolver. On Android Termux,
`process.execPath` can be the platform linker rather than the `PREFIX/bin/node`
launcher; using it directly causes detached jobs and Stage services to fail with
`bad ELF magic`.

The Registry client may refresh a public catalog and download only a structured,
catalog-listed `source_tar`. GitHub entries may first use the catalog-derived
tag archive with a short probe; if that path is unavailable, the client must
call the Registry `check` endpoint and use its converted archive. Both paths
must verify the declared size and SHA-256 while streaming before handing exact
bytes to the local Package Manager as a preflight candidate. If both paths
fail, the client returns a structured manual Release URL. It never accepts an
arbitrary URL, stores a Registry credential, or installs automatically.

The Package Manager snapshot preserves public attribution metadata separately
from the stable Package ID: `admin_title`, `publisher`, `license`, and the
optional `release.repository`. Administration may display that metadata, but
must never derive or expose credentials, private paths, or device identity.

Configuration is never read as stored. `config-migrate.mjs` builds the running version's
configuration from that version's defaults, transplanting every value the device already had by its
own key path. There is no version-to-version mapping table: such a table has to be correct for every
pair of versions anyone might upgrade between, and is silently wrong the moment someone skips a
release. A key that keeps its meaning keeps its path; a key that changes meaning gets a new path and
counts as new. Keys the running version no longer declares are preserved, not dropped.

The stored file holds overrides only — what differs from this version's defaults, plus undeclared
keys. Materialising defaults into the file means a later release can never change one, because the
old value is sitting there waiting to be transplanted back over the new default.

The update boundary check compares those settings, not the file's bytes. Hashing bytes made "this
version added a key" indistinguishable from "someone edited a setting", which made migration and the
boundary check mutually exclusive and left a device that had fallen far enough behind unable to
update at all. Credentials are outside the fingerprint and outside the stored configuration: the
server resolves them at startup, so serialising the live configuration object would write the
administrator password into the persistent tree.

`setup-state.mjs` decides what a browser sees at `/admin`. A device whose credentials nobody has
claimed shows the setup step rather than a login form, because the password is generated into a
private file and the product assumes the user never opens Termux. Both the setup step and the
post-update review reveal credentials, so both answer local requests only; every other origin gets
the login form regardless of state. Whoever reaches the panel over the network is not the person
holding the phone.

A loopback browser is the person holding the phone, so it enters the panel without a password and
changes that password without proving the old one. The password exists to keep other machines out;
requiring it on the device only sends the user looking for a credential they were never shown. This
is a real session rather than an authentication bypass, so CSRF still applies to writes: another page
on the device can post to loopback, but it cannot read the token that makes the post count. Every
non-loopback origin keeps the full password path, and that is what the remote half of the access
smoke exists to prove.

Credentials and browser sessions stay in Termux-private storage. Administration code must not expose secrets. Device verification must report the exact installed release it inspected.
