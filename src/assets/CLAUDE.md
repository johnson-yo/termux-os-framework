# Asset lifecycle contract

Core records generic Asset declarations, immutable payload facts, selections, and verified locations. It does not interpret or execute models. A Manager or Asset Package owns model payload lifecycle; Core may expose policy-free raw-byte primitives for independently licensed payloads under `/sdcard/termux-os/models/`.

## Members

- `declarations.mjs`: derives the current Declaration Index from active Installed Root manifests and Dev Mounts. It does not persist duplicate registration state or touch payload bytes.
- `registry.mjs`: stores the v2 Payload Ledger and Selection map, with generation/CAS and a short-lived v1 compatibility projection. Payload Object identity is a SHA-256 of its canonical path/size/SHA-256 file manifest; per-caller file roles are metadata and do not create a second object.
- `migration.mjs`: imports v1 path facts into v2 as legacy Payload Objects without moving or deleting model bytes.
- `resolver.mjs`: combines Declaration + Selection + Payload into a usable state. `required/optional`, provider loaded state, and consumer declarations are not lifecycle permissions.
- `fetch.mjs`: v1 compatibility transfer code. New callers use `transfer/http.mjs` and `transfer/staging.mjs`, which consume an explicit URL/stream and never construct a source-brand URL.
- `transfer/`: policy-free HTTP/push, staging, journal, commit, and removal primitives. These enforce path, size/hash, atomicity, containment, and CAS invariants only.
- `runtime.mjs`: generic Asset registration/runtime metadata. Loaded provider state is observation only; it is not a Manager payload gate.
- `payload.mjs`: v1 compatibility removal. New deletion uses `transfer/removal.mjs`; it may remove Package-provisioned and optional bytes after the caller explicitly detaches current selections. Removal preserves the Asset declaration; unregistering is a separate Package operation.
- `archive.mjs`: the generic raw Asset archive import boundary. The archive manifest owns package/version/target identity and every file's size and sha256; extraction rejects traversal, symlinks, special files, conflicts, and unverified bytes.

## Raw payload boundaries

Package-facing Managers may ask Core for policy-free transfer, archive, verification, atomic-storage, or safe-path primitives, or may implement the source-specific part themselves. The Manager owns when and why a payload is downloaded, updated, verified, stored, or deleted. Core may enforce shared-store containment, file type, size/hash, atomicity, and ownership invariants, but must not gate the operation because an Asset is required/optional, because its declaring Package is loaded/unloaded, or because a consumer declaration exists. Deleting payload bytes is separate from unregistering the Asset declaration.

The read-only `GET /api/packages/model-declarations` seam enumerates each installed Package's `.models/<owner>/<repository>` files. It is a generic filesystem contract: malformed roots and entries remain explicit errors, and no consumer ledger is persisted by Core.

## Two independent axes

A Package's `targets[]` describes where its code runs. An `assets.provides[]` entry's `target` describes where its bytes are valid. They are not the same question and must not be collapsed.

The store directory comes from the payload's target. Two variants sharing one directory would overwrite each other, and an EPContext wrapper referencing `./model.bin` would then open the wrong pair and fail inside the runtime. A repeated asset id with no target is a manifest error. Selection failure reports the device profile alongside the variants that exist.

## Catalog-owned variants

`assets.provides[].target: "device"` declares an Asset whose device variants are listed by the
catalog, not by the manifest. Every reader expands it through `resolveAssetTarget` to this device's
concrete target, so the Declaration Index, variant selection, and transfers all see an ordinary
target id; the literal `device` never reaches a caller. Such a declaration carries no source files:
a Manager resolves the files for the expanded target from its catalog and pulls them through the
normal transfer primitives. An unknown device expands to a non-matching `device-unknown` variant.

## Selection projection

`<models>/.objects/selections.v1.json` is a read-only copy of the current Selections (asset,
variant, payload id, object path), rewritten from the ledger whenever an operation writes it — never at startup and never by the
startup v1 migration, because the update boundary check fingerprints every file under the model
store (path, size, mtime) and a write in that window rolls the update back. Identical content is
not rewritten.
It exists because the Android App cannot read Termux private storage, while the object store keeps
superseded payloads. The ledger stays authoritative; a projection write never fails a ledger write.

## Where the bytes come from

Source selection and upstream-specific URL construction belong to the calling Manager or Asset Package. Core transfer primitives consume an explicit, already-resolved source request or byte stream plus expected file metadata. Core must not encode Hugging Face, ModelScope, GitHub, or any other source as built-in policy. A Manager may choose direct, a catalog proxy, or another adapter and then ask Core to perform generic streaming, resume, verification, and atomic storage. For sufficiently large fresh files, the generic HTTP primitive may use a bounded set of explicit byte ranges; this is a transport optimization, not source or package policy.

Only reaching response headers is time-boxed. Bounding the whole transfer would make large assets impossible: reachability and transfer are different timeouts.

## Why `.part` outlives a failure

A `.part` file is the resume base for the single-stream path, so it survives an interrupted transfer. It can never be mistaken for the finished asset because only a complete verified file is renamed. A prefix proven wrong is discarded, and a server that answers a Range request with 200 is treated as a restart rather than appended. Parallel fresh ranges are written into a preallocated staging file and are committed only after the complete file is hashed and verified; a failed parallel batch is discarded and retried from zero because it has no safe contiguous resume prefix.

## What never happens here

Silently using the wrong target, downloading without an explicit Manager/Package request, picking an older asset of unknown provenance, reporting ready for bytes that are not on disk, or deleting a declaration as a side effect of deleting its payload.
