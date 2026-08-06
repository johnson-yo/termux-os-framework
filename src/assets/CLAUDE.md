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
- `fetch.mjs`: the non-archive acquisition path. Each source file is streamed
  from where it already lives and hashed while it is written, because the failure
  this guards against is truncation, which looks complete on disk.
- `runtime.mjs`: the provider registry and `fetchOptionalAsset` — variant
  selection plus the on-demand download of an asset that was declared but
  deliberately not installed.

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

## What never happens here

Silently using the wrong target, downloading without being asked, picking an
older asset of unknown provenance, or reporting `ready` for something that is
not on disk.
