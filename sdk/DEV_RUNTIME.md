# Dev Runtime

`dev` is not a kind of Package, a workspace, or a second instance. **A Package is either what
was released or something you have edited, and the work tree answers which.**

## The two dimensions

| Question | Answered by | Command |
|---|---|---|
| Is this code the same as what was released? | `git status` on the active version directory | `package-manager state <id>` |
| Will my edits reload automatically? | the watcher | `termux-os-sdk dev status <id>` |

They are independent. Watching a clean Package leaves it released; stopping the watcher on an
edited Package leaves it edited. There is no "enter dev mode" action, because entering it is
just editing a file.

## Commands

```sh
termux-os-sdk dev start  <package-id>   # watch the installed work tree, reload on change
termux-os-sdk dev status <package-id>   # Git state + watcher state + services
termux-os-sdk dev reload <package-id>   # reload now, without waiting for the watcher
termux-os-sdk dev stop   <package-id>   # stop watching; the Package keeps its state
termux-os-sdk dev logs   <package-id>   # logs of the Package's own services
```

The Package must already be installed: `dev` acts on the one installed copy, using its service
ids, ports, URL, configuration and data. Nothing is duplicated, shadowed, or namespaced.

## Change detection and reload

The watcher treats the work tree's paths as the truth. `fs.watch` only makes a change noticed
sooner; a reconciliation scan (every 2 s, `TERMUX_OS_DEV_SCAN_MS` to tune) compares each path's
type, size, mtime, and inode, so a file replaced by an editor, an agent, or `git checkout` keeps
being seen on every later save. `.git`, `.sdk`, `.runtime`, and `node_modules` are never watched.

Changes that arrive together are handled together once the tree has been quiet for a moment:
a change under the WebUI directory refreshes open dev pages; any other change reloads the backend
once, and the page follows. A branch switch therefore lands as one reload with web and backend on
the same commit.

A reload never removes a working runtime before its replacement has loaded. The candidate is
checked first (manifest, compatibility, module import); if that or its `register()` fails, the
previous runtime keeps serving, `dev status` reports `last_reload_result: "failed"` with a
`dev_reload_failed` error, and the next save retries automatically. `context.configRoot` is always
`<packageRoot>/config`; a generation only isolates the module cache.

A page opened while the Package is watched keeps a slow poll through `dev stop` and reloads itself
when the next `dev start` begins.

For host-to-device iteration, use the formal sync path before starting the watcher:

```sh
termux-os-sdk dev sync <package-id> --connection <name> --source /absolute/path/to/repository
termux-os-sdk dev start <package-id>
```

Framework reconcile reports the active path/version, Git `HEAD` and released `HEAD`, dirty state,
previous/archive rollback material, generation owner, watcher, owned services, and any legacy or
duplicate identity. A conflict blocks install, restore, rollback, uninstall, and dev writes until
it is explicitly reconciled. The old `~/termux-os-dev/packages` source is report-only and can be
moved to the private legacy archive without deleting user content.

## Development provenance

Editing an installed Package is allowed at any time, and the Git state reports it (`modified`).
Declaring that you are developing it is a separate, explicit act:

```sh
node scripts/package-manager.mjs activate-development <package-id>   # or: termux-os-sdk dev activate <id>
node scripts/package-manager.mjs development-status   <package-id>   # state + provenance + Git history
```

Activation records the official baseline in `<packageRoot>/.development/` and changes nothing else:
no Git file, branch, workspace, or watcher. It is sticky — `dev stop`, a Framework restart,
`git reset --hard` to the release, or a clean `git status` do not end it. Only a verified official
restore or install makes the Package `official` again. Activation needs verifiable Git lineage
(a `.git` and a released HEAD); a Package without it answers `development_lineage_unavailable`.

Local history is everything that would be lost by replacing the directory: work-tree changes, HEAD
off the release, local branches or tags with unreleased commits, and the stash. Restore, update,
and uninstall refuse when it (or Development provenance) is present; add
`--preserve-development` to back up first or `--force-discard` to discard. Backups keep `.git`:

```sh
node scripts/package-manager.mjs development-backups <package-id>
node scripts/package-manager.mjs restore-development-backup <package-id> <backup-name|sha256-prefix>
```

## Returning to the released content

Editing is one-way by design; a cleared flag would not un-edit a file. Restore the bytes:

```sh
node scripts/package-manager.mjs restore <package-id> [--preserve-development | --force-discard]
```

That unpacks the original Release archive saved at install time, verified against its SHA-256.
Configuration, persisted data and shared assets live outside the work tree and are untouched.

A Framework or Package update refuses to run over an edited work tree rather than overwriting it.

## What was removed

`<id>@<slug>` instances, `--workspace`, `--slug`, `--use-live-data`, `data_mode: isolated|live`,
isolated dev data roots, and the dev mount state file. They existed to run a workspace copy
beside the released Package; with a single instance there is nothing to keep apart, and a stored
"is dev" flag would be a second source of truth that can be cleared while the edit survives.
