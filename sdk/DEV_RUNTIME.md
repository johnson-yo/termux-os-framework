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

## Returning to the released content

Editing is one-way by design; a cleared flag would not un-edit a file. Restore the bytes:

```sh
node scripts/package-manager.mjs restore <package-id>
```

That unpacks the original Release archive saved at install time, verified against its SHA-256.
Configuration, persisted data and shared assets live outside the work tree and are untouched.

A Framework or Package update refuses to run over an edited work tree rather than overwriting it.

## What was removed

`<id>@<slug>` instances, `--workspace`, `--slug`, `--use-live-data`, `data_mode: isolated|live`,
isolated dev data roots, and the dev mount state file. They existed to run a workspace copy
beside the released Package; with a single instance there is nothing to keep apart, and a stored
"is dev" flag would be a second source of truth that can be cleared while the edit survives.
