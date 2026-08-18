# Scripts directory contract

Scripts here operate Framework Core, deterministic releases, local fixtures, or publication checks.

- Device aliases, IP addresses, product engines, models, and vendor build tools do not belong here.
- Tests must isolate home, ports, Installed Root, state, and generated artifacts.
- `framework.sh` is the runtime controller. On Termux it is installed in private Home as `~/framework.sh`; the installed controller has a POSIX trampoline so direct execution works on Android even though Android lacks `/usr/bin/env`, while the implementation still runs under Termux Bash. Web Update invokes that trusted controller and never replaces it. The independent public `install.sh`, `upgrade.sh`, and `uninstall.sh` entrypoints are the source-release lifecycle path and may intentionally install a new controller after archive verification.
- `framework.sh reset-password` is the local private-auth recovery command; it
  must never accept or persist a password through public Framework config.
- On Termux, the installer and `framework.sh` use the normal application
  resolver; they do not require `adb`, `su`, or a process-wide DNS wrapper.
- `package-manager.mjs` is the single Package release and installation engine.
  Public Package releases require `README.md`, `AGENTS.md`, `NOTICE.md`, and
  `LICENSE`; internal `CLAUDE.md`, `DEVELOPMENT.md`, `.sdk/`, and handoff notes
  stay out of the immutable archive.
- `hooks/` holds the Git hooks that enforce Commit discipline; install with
  `git config core.hooksPath scripts/hooks`.
- `public-files.txt` is the exact public-source allowlist. `export-public-tree.mjs`
  copies only those files to an ignored staging tree, and
  `check-publication.mjs --tree` rejects anything outside the list.
- `install.sh`, `upgrade.sh`, and `uninstall.sh` verify the Registry `framework`
  type, exact archive size, SHA-256, and package version before changing the
  runtime. They preserve private configuration, credentials, Package data,
  models, caches, and runtime observations outside the release tree.
- Shell scripts keep the shebang first, followed by an English Apache-2.0 header.
