# System module contract

System modules own Framework authentication, browser sessions, CSRF, administration, jobs, access reporting, observations, Package control and Package Setting state, the public Package Registry client, and Framework updates. Package Setting state is private persistent metadata: it may change Package port assignments/visibility and enablement without changing an immutable Release.

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

Credentials and browser sessions stay in Termux-private storage. Administration code must not expose secrets. Device verification must report the exact installed release it inspected.
