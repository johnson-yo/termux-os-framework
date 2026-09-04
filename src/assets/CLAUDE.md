# Asset registry contract

Core records immutable asset identity, version, target, checksums, and verified locations. It does not contain, download, interpret, or execute models. Model payloads remain in independently licensed asset Packages under `/sdcard/termux-os/models/`.

## Members

- `registry.mjs`: the active-asset ledger and the shared store layout
  (`<store>/<package>/<version>/<target>/`). Activation keeps the previous entry
  so a rollback moves a pointer instead of half a gigabyte.
- `resolver.mjs`: answers "is this asset usable here" — registered, target
  matches this device, files present, and optionally checksummed. It never picks
  a near miss: a context built for another DSP architecture is not a worse
  option, it is a load-time failure with a misleading name.
- `fetch.mjs`: the non-archive acquisition path, plus the routing and resume
  policy. Each source file is streamed from where it already lives and hashed
  over exactly the bytes that land, because the failure this guards against is
  truncation, which looks complete on disk.
- `runtime.mjs`: the provider registry and `fetchOptionalAsset` — variant
  selection plus the on-demand download of an asset that was declared but
  deliberately not installed.
- `payload.mjs`: the generic, expectation-checked raw payload purge boundary.
  It may remove only a registered path below the shared Asset Store and never
  touches a Package's private data or adjacent cache roots.
- `archive.mjs`: the generic raw Asset archive import boundary. The archive
  manifest owns package/version/target identity and every file's size and
  sha256; extraction rejects traversal, symlinks, special files, conflicts,
  and unverified bytes.

## Raw payload boundaries

Package-facing managers may ask Core to fetch, import, verify, or purge raw
Asset payloads. Core owns the registry, shared-store path, `.part` transfer,
hash/size verification, atomic rename, and safe deletion. An archive is a
`tar.gz` with `termux-os.asset-archive.json` plus `payload/<asset>/<file>`;
the archive is not a second model or runtime manifest.

The read-only `GET /api/packages/model-declarations` seam enumerates each
installed Package's `.models/<owner>/<repository>` files. It is a generic
filesystem contract: malformed roots and entries remain explicit errors,
and no consumer ledger is persisted by Core.

## Two independent axes

A Package's `targets[]` describes where its **code** runs. An
`assets.provides[]` entry's `target` describes where its **bytes** are valid.
They are not the same question and must not be collapsed: a Package holding a
V73 and a V79 context contains nothing device-specific itself, because a remote
payload ships coordinates rather than weights.

Consequences enforced here rather than left to convention:

- The store directory comes from the payload's target. Two variants sharing one
  directory would overwrite each other, and an EPContext wrapper referencing
  `./model.bin` would then open the wrong pair and fail inside the runtime.
- A repeated asset id with no target is a manifest error. Resolution order is not
  a meaning.
- Selection failure reports the device profile alongside the variants that exist,
  because "mismatch" without the device's own side is not actionable.

## Where the bytes come from

Every source file carries its own coordinates, and now also its own `host`
(`huggingface` by default, or `github`). Two ways to fetch the same coordinates:

- **direct** — upstream itself (`huggingface.co/<repo>/resolve/<rev>/<path>`,
  `raw.githubusercontent.com/<repo>/<rev>/<path>`).
- **registry** — the Catalog proxy, which adds allow-listing, host restriction
  and observability.

`via: 'auto'` is the default and means **direct first, Catalog only when direct
does not answer**. The Catalog is a fallback, not a toll booth: both routes serve
the same revision at the same path, so the declared sha256 decides either way,
and a working upstream should not be proxied. Without a Catalog address `auto`
degrades to direct-only — usable, but with no fallback left, which the result
says out loud rather than leaving to whoever reads the source.

Only reaching the response headers is time-boxed (`DIRECT_HEAD_TIMEOUT_MS`).
Bounding the whole transfer instead would make every large asset impossible:
reachability and transfer are two different timeouts, and collapsing them is
the same mistake as calling a 937 MB download slow when it was never allowed to
finish.

## Why `.part` outlives a failure

A `.part` file is the resume base, so it survives an interrupted transfer and
the call that gave up. It can never be mistaken for the finished asset, because
that guarantee comes from the *name*: only a verified file is ever renamed.

The rule this replaces — delete on any failure — made every retry start at zero,
which on a link that drops makes the success rate fall away as the file grows.
A prefix that is *proven* wrong is still discarded at once (a full-length body
whose digest does not match), and the final attempt always restarts from zero,
so a poisoned prefix cannot make one file permanently unfetchable. A server that
answers a `Range` request with `200` is restarting the file, not continuing it,
and is handled as such.

## What never happens here

Silently using the wrong target, downloading without being asked, picking an
older asset of unknown provenance, or reporting `ready` for something that is
not on disk.
