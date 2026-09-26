# Extension Package SDK

The SDK is the shortest supported path from an idea to a running Package and then to an immutable
installed release. On a phone the primary flow needs nothing but Termux, Git, the Framework, and
this SDK:

## On-phone local development (start here)

```sh
termux-os-sdk new --type app --template web --dev \
  --id org.example.app.my-app --name "My App"      # runnable at once; no release, no restart
termux-os-sdk dev start org.example.app.my-app     # hot reload while you edit
cd "$(termux-os-sdk dev status org.example.app.my-app --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).worktree')"
# edit web/, test in Chrome at http://127.0.0.1:8980/packages/org.example.app.my-app/
git switch -c feature/x && git commit -am "…"     # the installed work tree is the Git repository
termux-os-sdk test org.example.app.my-app --json
termux-os-sdk verify-device org.example.app.my-app --dev --json
termux-os-sdk release org.example.app.my-app       # builds from that same work tree
termux-os-sdk install /absolute/path/to/release.tar.gz   # first official Release (same version)
```

`termux-os-sdk` is on `PATH`: every Framework start links `$PREFIX/bin/termux-os-sdk` to the
active Framework's `sdk/termux-os-sdk`, so it follows updates and rollbacks and never goes stale.
A file of that name that Framework did not create is left alone (reported as a collision in
`/api/access-info`).

### The Agent control surface

Framework lifecycle goes through the SDK; source history goes through `git`; GitHub goes through
`git`/`gh`. An Agent never needs `curl`, `scripts/package-manager.mjs`, or `scripts/package-job.mjs`.

| Need | Command |
| --- | --- |
| Everything about one Package (state, work tree, Git lineage, watcher, last reload, rollback, services, backups) | `termux-os-sdk dev status <id> --json` |
| Watch / reload / stop watching | `termux-os-sdk dev start\|reload\|stop <id>` |
| Enter Development on an official Package | `termux-os-sdk dev activate <id>` |
| Stage services | `termux-os-sdk service list [<id>]`, `service status\|start\|stop\|restart\|logs <service-id>` |
| Back up / list / restore the whole work tree (`.git` included) | `termux-os-sdk dev backup\|backups <id>`, `dev restore-backup <id> <backup>` |
| Return to the verified official Release | `termux-os-sdk restore <id>` |
| Switch to the previous installed Release | `termux-os-sdk rollback <id>` |
| Uninstall (keeps `config/`) | `termux-os-sdk uninstall <id>` |

`restore`, `uninstall`, and `dev restore-backup` refuse with `development_backup_required` (or
`local_history_present`) when they would destroy local history. Choose explicitly:
`--preserve-development` backs the work tree up first; `--force-discard` discards it. These are
the same guards the WebUI uses; the SDK adds no safety decision of its own.

`install`, `restore`, `rollback`, and `dev restore-backup` replace the version directory atomically,
so a shell that was inside the old work tree is left in a deleted directory. Re-enter it afterwards:
`cd "$(termux-os-sdk dev status <id> --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).worktree')"`.

With `--json`, stdout is exactly one JSON object and every log line goes to stderr, so
`OUT="$(termux-os-sdk … --json)"` can be parsed directly. Failures carry a stable `code` and a
concrete `fix`. There is intentionally no `termux-os-sdk git …`, `branch`, or `push`: use Git.

`new --dev` creates a *development-only* Installed Package: `~/.termux-os/packages/<id>/versions/<v>/`
is its one Git work tree (a local baseline commit, a repo-local Git identity — a marked placeholder
when Git has no global identity), there is no official Release yet, and restore/rollback say so.
The first `install` of a Release built from the current HEAD makes it official and backs up the
development history automatically. To change an official Package later, enter Development
explicitly (`termux-os-sdk dev activate <id>` or the Develop action in the Package Manager) and edit the same tree.

Everything below describes the separate-source-repository workflow, which remains supported for
larger projects and for development from another machine.

For a public GitHub + Package Registry + phone-market release, read
[Public Package publication](PUBLISHING.md) after this page. It explains the
two archive identities, the Registry review/publish boundary, credential
separation, and the final catalog-install acceptance path.

For an AI-assisted implementation, begin with
[the copy-ready Agent prompt](AI_AGENT_PROMPT.md). It captures the current
Package boundary, Browser Session, System Key, port, mobile WebUI, and release
contracts in one place.

Use `termux-os-sdk` when the executable is on `PATH`. Otherwise invoke
`<framework-root>/sdk/termux-os-sdk`. Package source never belongs under a
Framework-owned `packages/` directory.

## 1. Choose the type

```sh
termux-os-sdk choose \
  --extends-existing no \
  --data-only no \
  --integrates-external no \
  --long-running yes \
  --combines-capabilities no
```

See [Package types](PACKAGE_TYPES.md).

## 2. Create or inspect a Package

```sh
termux-os-sdk new \
  --type service \
  --id org.example.service.demo \
  --name "Demo Service"

termux-os-sdk inspect org.example.service.demo
```

The default source root is `~/termux-os-sources/`. Set `TERMUX_OS_SOURCE_ROOT` to use another
collection, or run the SDK from the Package Git repository itself. The old
`~/termux-os-dev/packages/` tree is legacy: `context` and `reconcile` report it, but the SDK never
loads or watches it.

## 3. Build confidence

```sh
termux-os-sdk doctor org.example.service.demo
termux-os-sdk test org.example.service.demo
termux-os-sdk dev start org.example.service.demo
```

Remote / advanced — only when the source lives on another machine:

```sh
termux-os-sdk dev sync org.example.service.demo \
  --connection <name> --source /absolute/path/to/the/repository
```

`dev` watches the installed active worktree; it does not create a second Package. A sync is atomic,
keeps `config/`, persistent data, and assets outside the version directory, and reports the target
path and Git diff before replacing it. Runtime generations are module-cache copies only and never
become Package identities.

## 4. Release and install

```sh
termux-os-sdk release org.example.service.demo
termux-os-sdk install /absolute/path/to/release.tar.gz
termux-os-sdk verify-device org.example.service.demo
termux-os-sdk handoff org.example.service.demo
```

The release path is Source → deterministic archive → verification → target check → immutable Installed Root. Read [the contracts](CONTRACTS.md) before adding native code or model assets.
