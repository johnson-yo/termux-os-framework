# Asset transfer primitives

This directory contains policy-free raw byte mechanics for Asset payloads.
Callers provide an explicit URL or an input stream, expected relative file
paths, sizes, and SHA-256 values. These modules do not know Hugging Face,
ModelScope, GitHub, Package optionality, provider readiness, or consumer use.

- `http.mjs` handles response-head timeout, Range resume, streaming, and hash.
- `staging.mjs` validates relative paths, writes `.part` files, and verifies a
  complete staged file set.
- `journal.mjs` persists restartable operation facts without credentials.
- `lock.mjs` serializes commit/delete byte transitions per Payload id and recovers stale process locks.
- `commit.mjs` makes a content-addressed Payload Object and optional Selection.
- `removal.mjs` performs expectation/CAS-protected object removal. Warning and
  user confirmation belong to the replaceable Manager Package.

Changes here must be reflected in the parent `src/assets/CLAUDE.md` and the
Framework public-file allowlist.
