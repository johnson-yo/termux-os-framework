# Local device development

On a phone, the installed active work tree **is** the source. One Git repository serves as source,
runtime, watch target, and release input:

```text
~/.termux-os/packages/<id>/
├─ active.json
├─ versions/<version>/   ← the one work tree: .git, manifest, package.mjs, web/
├─ config/               ← Package settings (outside the work tree, kept across updates)
├─ .development/         ← Development provenance (outside the work tree)
└─ archive/              ← official Release archives, once there is one
```

## Primary flow: zero-create on the phone

```sh
termux-os-sdk new --type app --template web --dev --id <package-id> --name "<Name>"
termux-os-sdk dev start <package-id>
termux-os-sdk dev status <package-id> --json      # .worktree is where to edit and commit
# edit, check Chrome, git branch/commit in that work tree
termux-os-sdk release <package-id>                # built from the same work tree
termux-os-sdk install <absolute-release.tar.gz>   # first official Release
```

`new --dev` needs no Release, install, or Framework restart: it writes the Installed Root, makes a
local baseline commit, records Development provenance, and asks the running Framework to load the
Package. The baseline commit is local history, not a release: `restore` answers
`official_baseline_unavailable` and `rollback` answers `no_previous_release` until an official
Release is installed. Installing a Release built from the current HEAD backs up the development
history (branches, commits, stash) and makes the Package official at the same version.

## Changing an official Package

Enter Development explicitly — `termux-os-sdk dev activate <package-id>` or the Develop action in the
Package Manager — then `dev start` and edit the same installed work tree. Development is sticky; only a
verified official restore or install ends it. See [Dev Runtime](DEV_RUNTIME.md).

## Remote / advanced: source on another machine

`host Git repository → dev sync → phone active worktree` remains available for a source repository
kept elsewhere (`termux-os-sdk dev sync <id> --connection <name> --source <repo>`, and the SSHFS
view `dev-mount`). It is not needed on the phone and does not shape the local flow.

`~/termux-os-dev/packages/` and `TERMUX_OS_DEV_ROOT` are retired legacy locations. Framework and SDK
report them and provide `legacy-archive`, but never load, watch, or silently delete their contents.

Do not put a phone address, SSH alias, or token in Package source. Models remain in
`/sdcard/termux-os/models/`; Package code and private state remain in Termux-private storage.
