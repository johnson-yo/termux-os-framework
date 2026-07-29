# termux-os-framework contributor instructions

## Mission

Maintain a small, reliable, local-first Framework Core that gives independently licensed Extension Packages the widest practical room to cooperate.

## Hard boundary

Core owns Package lifecycle, Capability routing, service supervision, application coordination, release/update integrity, authentication, administration, and the SDK contracts.

Core must not bundle or implement audio processing, speech engines, TTS engines, language models, translation engines, model assets, vendor runtimes, device-specific applications, or product workflows. Those belong in independent Extension Package or application repositories.

Core must start successfully with zero installed Packages and report an empty Package and service inventory.

## Read order

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. the nearest directory-level `CLAUDE.md`
4. the English header of the target file

`AGENTS.md` is a symbolic link to this file.

## Directory map

- `.github/`: continuous-integration workflows (the backstop for Commit discipline)
- `config/`: public, non-secret defaults
- `docs/`: public architecture and maintenance documentation
- `scripts/`: lifecycle, release, audit, and test commands
- `sdk/`: Extension Package SDK, templates, schemas, and examples
- `src/`: Framework Core server and runtime modules
- `web/`: Framework-owned administration interface
- `dist/`: ignored generated releases
- `tmp/`: ignored temporary work

There is deliberately no first-party `packages/` directory. Package source is developed in independent repositories or under `~/termux-os-dev/packages/`; installed runtime truth is `~/.termux-os/packages/`.

## Change rules

- Use only Node.js standard-library APIs in Core unless a new dependency is demonstrably unavoidable.
- Preserve the Source → Release → Installed separation.
- Never place credentials, browser sessions, private audio, or device identities in source or shared configuration defaults.
- Keep models at `/sdcard/termux-os/models/` and caches at `/sdcard/termux-os/caches/`; Framework updates must not overwrite them.
- Keep all public documentation and file headers in English.
- Add `SPDX-License-Identifier: Apache-2.0` to comment-capable source files.
- Keep localized user content outside file headers; localization is allowed when it is a deliberate product concern.
- Do not add a device IP, SSH alias, workstation path, private hostname, access token, or default password.
- Do not push or create a remote unless the repository owner explicitly requests it.
- Read configuration through the migration in `src/system/config-migrate.mjs`; never dereference a
  stored setting directly. A bare `CFG.section.key` throws on any device installed before that key
  existed, which fails the update and rolls the device back — the further behind it is, the harder
  it becomes to catch up.
- Store overrides, not defaults. A default written into a device's configuration file can never be
  changed by a later release, because it is transplanted back over the new one.
- Assume the user never opens Termux. Anything they must do to run this system has to be possible in
  the browser, including reading the credentials the installer generated for them.
- Update the nearest `CLAUDE.md` when a directory contract changes.

## Required checks

```sh
npm test
npm run check:public
```

Package-specific behavior must be tested in that Package repository. Core tests may use only isolated fixtures and temporary directories.

## Commit discipline

These rules are permanent. They apply to every contributor, including the
repository owner, and to every automated agent. `AGENTS.md` links here, so this
section is the single source of truth for how history is written.

- **Single maintainer identity.** Published history is written under one
  maintainer identity (`Johnson.Y`). Configure the identity with local
  `git config`. Never write a personal email address into a tracked file; it
  belongs in commit metadata only.
- **Linear, clean history.** The public history begins at the independent root
  commit. Never graft, merge, or cherry-pick pre-publication private history,
  retired first-party `packages/`, model blobs, or device deployment evidence
  back into this repository.
- **Message shape.** Subject is `type(scope): summary`, English, imperative, at
  most 72 characters. Allowed types: `feat fix docs refactor test chore perf
  build ci revert`. The body explains *why*, plus any compatibility, storage,
  security, or migration effect. No Chinese in commit messages.
- **Never commit.** Secrets, credentials, browser sessions, private audio,
  device aliases, private paths or IP addresses, access tokens, model or opaque
  binaries, generated releases (`dist/`), or first-party Package source.
- **Green before commit.** A commit must pass `npm test` and
  `npm run check:public`. A commit that cannot be verified must not be made.

### Enforcement

The rules above are enforced locally, not just documented. Install the hook once
per clone:

```sh
git config core.hooksPath scripts/hooks
```

`scripts/hooks/commit-msg` rejects a non-English or malformed subject and any
private path, device alias, address, or legacy credential in the message. CI is
the backstop: it runs `npm test` and `npm run check:public` on every change.
Hooks and CI guard the same contract from two sides.
