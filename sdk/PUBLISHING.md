# Public Package publication

This guide covers an independent Extension Package that must be published on
GitHub, admitted to the public Package Registry, and installed through the
Framework catalog. It supplements [START_HERE.md](START_HERE.md); it does not
replace the Package self-test, SDK doctor, release verification, or Device
Verify requirements.

## Framework Core publication boundary

Framework Core is not an SDK Package. Its public repository is exported from
the Framework source tree with `scripts/public-files.txt`, an exact
repository-relative allowlist:

```sh
npm run public:export
npm run public:check
```

The exporter copies only allowlisted files into ignored `tmp/public-tree/`.
Local maintainer handoffs, device evidence, generated SDK state, credentials,
workstation paths, and private development notes may remain in the local source
tree but must not be added to the allowlist. In particular, an example's
`.sdk/handoff.md` and `.sdk/project.v1.json` are local SDK state, not public
Framework source. SDK runtime code, schemas, templates, generic examples, and
their public documentation are included only when explicitly listed.

The public Framework repository is committed from the exported tree as an
independent clean history. Run `npm test` and `npm run check:public` against
the source before exporting, then run `npm run public:check` against the exact
tree that will be committed. This boundary check is separate from
`.deployignore`, which controls phone deployment rather than publication.

## Keep the three release identities separate

There are three related but different artifacts:

| Artifact | Produced by | Used for | Integrity value |
|---|---|---|---|
| Public GitHub tag archive | GitHub after the tag is pushed | Registry `source_tar` download | Hash measured from the exact tag URL |
| Deterministic Framework archive | `termux-os-sdk release` | Local install and an optional Release asset | SDK release hash and sidecars |
| Installed Package | Core Package Manager | Runtime on the device | Installed identity plus release hash |

The Registry `source_tar` must point to the public GitHub tag/commit archive.
It must not be replaced with the deterministic archive produced locally by the
SDK. The two archives can contain the same files while having different top
directories, sizes, and SHA-256 values. A Release may carry the deterministic
archive as an additional asset, but that does not change the Registry source
selection.

## Prepare a public source tree

Before creating the public repository, make a fresh staging tree containing
only the Package source and intentionally public files:

- `termux-os.package.json`, `README.md`, `LICENSE`, `NOTICE.md`, and `AGENTS.md`;
- declared entry points, tests, smoke checks, and WebUI assets;
- a Package-local `.gitignore` for SDK notes, local state, logs, and temporary
  files.

Do not copy `.sdk/`, `HANDOFF.md`, `DEVELOPMENT.md`, private evidence, device
logs, model weights, credentials, browser sessions, or workstation paths into
the public tree. Scan the staged tree before the first commit.

The manifest uses the plural type list. A user-facing dashboard is an App even
when it owns a background worker:

```json
{
  "id": "org.example.app.dashboard",
  "types": ["app"],
  "components": { "apps": ["dashboard"], "services": ["app.dashboard"] }
}
```

Do not introduce a scalar `type` field or rename an App package to `service`
because its implementation has a worker. Keep the Package ID stable; the
worker ID is a separate runtime concern.

## Prove the local release

Run these from the Package repository, using the current SDK:

```sh
termux-os-sdk inspect <package-id> --json
termux-os-sdk doctor <package-id> --json
termux-os-sdk test <package-id>
termux-os-sdk release <package-id> --json
```

Record the deterministic archive path and SHA-256. Treat doctor warnings as
review items, not as proof of failure or proof of success; resolve or explain
each warning before publication. Install the exact archive locally and run the
declared `verify-device` hook before claiming device readiness.

## Publish the GitHub source

Use a clean public repository and a stable version tag:

```sh
git status
git add <intentionally-public-files>
git commit -m 'release: publish <package> <version>'
git push origin main
git tag -a <version-tag> -m '<version-tag>'
git push origin <version-tag>
```

Create the GitHub Release only after the tag resolves to the intended commit.
If `gh` is unavailable, use the GitHub REST API with a GitHub-only token; do
not move that token into Cloudflare or Framework configuration. Verify the
repository visibility, tag commit, Release state, and every uploaded asset.

Download the exact public tag archive, not an API commit archive, and record
its size and SHA-256:

```sh
curl -fsSL 'https://github.com/OWNER/REPOSITORY/archive/refs/tags/VERSION.tar.gz' \
  -o /tmp/package-source.tar.gz
stat -c '%s' /tmp/package-source.tar.gz
sha256sum /tmp/package-source.tar.gz
```

Repeat the download when the source is newly published. The GitHub archive
top-level directory may be named from the repository/tag; Framework verifies
the safe single root and normalizes it to the manifest Package ID.

## Register the public Package

The Package Registry and the License Worker are different services. The
Package developer portal is:

```text
https://package.termux-os.com/dev
```

The `/dev` form (or `POST /registry`) creates a `pending` application and
returns a one-time private review token. Keep that token out of logs and
public notes. Approval alone does not publish a Package.

The operator sequence is always:

```text
developer application
  → review application
  → upsert project
  → upsert version
  → upsert file
  → publish registry
```

For a GitHub tag source archive, use `kind: "source_tar"`,
`file_path: "source.tar.gz"`, and the same tag in `version` and
`upstream_ref`. Omit `upstream_asset_id` or send JSON `null`:

```json
{
  "kind": "source_tar",
  "file_path": "source.tar.gz",
  "upstream_asset_id": null,
  "size": 12345,
  "sha256": "<sha256-of-the-tag-archive>"
}
```

Do not send an empty string for `upstream_asset_id`. The validation boundary
treats an explicitly empty string as an invalid supplied value. Do not invent a
Release asset ID for `source_tar`; a numeric `upstream_asset_id` belongs to a
GitHub `release_asset` record. Retrying a file upsert with a different marker
creates a second D1 row because file identity includes that field.

The three operator credentials have separate owners and scopes:

| Credential | Scope | Never use it for |
|---|---|---|
| Cloudflare Account API token | Wrangler, D1, Worker deployment | Registry `/admin/*` |
| Worker `ADMIN_TOKEN` | Package Registry admin mutations | Cloudflare API or Package source |
| GitHub token | GitHub repository/Release operations | Worker secrets or phone runtime |

Use the public `/list` result as the catalog contract. It must show an active
project, a verified version, and a file with both size and SHA-256 before the
Framework can trust the download.

## Prove the phone market path

The market path is more than a successful HTTP download:

1. Refresh the Framework Package catalog after Registry publication; the phone
   may still have an older cached snapshot.
2. Open Details and check package ID, type, version, license, dependencies,
   permissions, network, and data notes.
3. Download the selected `source_tar`; wait for the Package check to report
   `Ready To Install` and confirm the displayed SHA-256.
4. Use the explicit Install action and confirm the exact Package ID, version,
   target, and file hash. A queued job is not a completed install.
5. Wait for the persistent operation to finish, then confirm Installed Root,
   `Runtime: Ready`, and the Package-owned `/packages/<package-id>/` page.
6. For an App with optional root features, test the root switch in both states:
   root-only fields must disappear when disabled while ordinary values remain;
   restore the intended user setting after the test.

To prove Registry installation rather than a local file install, remove an
existing copy with the same Package ID first, wait for uninstall completion,
refresh the catalog, and install from Available. Uninstall preserves separately
managed configuration/data, so verify the installed source/version and hash;
do not infer provenance from preserved state alone.

## Evidence and common traps

Record only public, reproducible evidence: Package ID, version, manifest type,
tag commit, both archive identities and hashes, Registry `list/check` results,
HEAD and a small Range response, the installed release identity, and Device
Verify output. Keep credentials, review tokens, device addresses, SSH aliases,
private paths, and user data out of the record.

Common failure patterns:

- `curl ... | jq ...` can hide a failed curl when `pipefail` is off; use
  `set -o pipefail` for mutation scripts and check each HTTP response.
- A successful developer submission is only `pending`; it is not an approved
  catalog entry and not an installable version.
- A published Registry entry does not appear on a phone until the catalog is
  refreshed.
- A browser action often returns a queued Framework job. Reconnect/poll until
  the operation is complete before inspecting the installed inventory.
- `https://app.termux-os.com/registry` is the License service endpoint, not the
  Package developer portal. Use `package.termux-os.com` for Package publication.
- A public GitHub owner/repository string is source attribution; it does not
  justify adding a real maintainer email, device identity, or private path to
  the Package.

After public publication, run the Package tests again from the source
repository and keep the public README/NOTICE concise. Internal release
reasoning belongs in a handoff or retrospective, never in the Package archive.
