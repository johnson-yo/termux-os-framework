# Maintainer handoff

Status: Framework Core independence, public-boundary cleanup, independent installer flow, and the 0.2.2 public update closure are complete. The local source tree intentionally has no GitHub remote; publication is performed from the explicit allowlist into a separate staging clone.

## Public publication checkpoint

- Public repository: `johnson-yo/termux-os-framework`
- Public `main` checkpoint: `d28e05e06b65d8f4a3b24e13ef9fb154b0b3420e` (`fix(update): record registry installer result`)
- Public identity: `Johnson.Y <johnson-yo@users.noreply.github.com>`; reachable history contains no `bobo10001` identity.
- Release tag: `0.2.2` (unprefixed); rollback release: `0.2.1`
- Registry active Framework versions: `0.2.2` and `0.2.1`; current public catalog counter: `27`
- Published `0.2.2` GitHub source archive: 295738 bytes, SHA-256 `561c2d4c1a98e759d27f5f6b1c4eba92b99fd8c1ac34918866f847ee6fdc5401`
- `/check` and `/download` on `https://package.termux-os.com` return the same size/SHA; a leading `v` version is rejected with HTTP 400.
- The pre-rewrite bundle is retained privately at `/mnt/2tb/termux-os/tmp/framework-public-history-pre-rewrite.bundle`; no public ref points to the old identity commits.

The public tree is controlled by `scripts/public-files.txt`. `npm run public:export` creates the tree and `npm run public:check` requires an exact allowlist match. The local maintainer handoff, private evidence, and SDK `.sdk` state remain outside the public tree. `.deployignore` is public because the isolated update smoke tests use it; it contains only build/runtime exclusion patterns and no credentials or private paths.

## Device update evidence

On zflip5 (`192.168.30.49:34202`), the complete update path was exercised:

`0.2.0 → Registry WebUI update → 0.2.2 → WebUI same-build boundary update`

The Registry WebUI downloaded and SHA-checked the public archive, preserved the
Framework configuration (`c261b10f062159726c5f5ee2e7192502c5c007493d70abc52b8b7c776a5c442`), and ended healthy at `0.2.2`. The successful WebUI job recorded
`framework-0.2.0 → framework-0.2.2`; the earlier failed job remains visible with
its exact `/tmp` error rather than being presented as success. The final
same-build WebUI update passed the boundary comparison, and the installer then
recorded the public archive SHA `561c2d4c1a98e759d27f5f6b1c4eba92b99fd8c1ac34918866f847ee6fdc5401` in `.framework-release.json`.

The device initially exposed two Android-specific environment faults: the old
runtime's backup tar could not follow its contributor-only `AGENTS.md` symlink,
and a detached worker without `TMPDIR` attempted `/tmp`. 0.2.2 now excludes only
that non-runtime symlink from last-good archives, falls back to private Home
staging, and injects the same private staging environment into detached Registry
workers. The normal app-context HTTPS check reached `package.termux-os.com:443`
without requiring `adb` or `su`; `su` was used only once to normalize the test
device's pre-existing symlink before the first legacy upgrade.

## Repository split

Framework Core contains no first-party `packages/` directory. The exact pre-removal Package trees were split into independent sibling repositories under `../termux-os-extensions/`:

| Repository | Split commit |
|---|---|
| `github.termux-os.adapter.android-app` | `e60d983d5030` |
| `github.termux-os.app.asr-timeline` | `046477e14622` |
| `github.termux-os.app.hello-responder` | `288a35ebdefd` |
| `github.termux-os.app.simultaneous-interpreter` | `29fed3bd97a8` |
| `github.termux-os.asset.sensevoice` | `ec90c69b09f9` |
| `github.termux-os.asset.wake-pinyin-app-htp` | `e5591a5028ed` |
| `github.termux-os.service.chat` | `7447a526f7b5` |
| `github.termux-os.service.device-status` | `db3701daf47e` |
| `github.termux-os.service.keyword-counter` | `65a27b4b3e38` |
| `github.termux-os.service.npu-top` | `f34264381b04` |
| `github.termux-os.service.speech-asr` | `06a40d8e63a6` |
| `github.termux-os.service.termux-pet` | `af1c4dbf2fe0` |
| `github.termux-os.service.translate-hymt` | `d030b61e65cb` |
| `github.termux-os.service.wake-words` | `38ea92596fef` |

Each is on local branch `main` with no remote. Their split trees were verified against the source trees. They preserve implementation history but have not received this Core repository's English documentation, secret cleanup, or final license review. Treat them as private migration inputs, not publication-ready releases.

## Core decisions

- Apache-2.0 applies only to Framework Core.
- Engines, models, applications, adapters, and services are separate Extensions with separate licenses.
- Core has no default device, host, IP address, integration token, or administrator password.
- First start creates credentials in Termux-private storage.
- Empty Core has zero installed Packages and zero product services.
- Audio processing and playback remain application-owned; Core handles text-level contracts and component lifecycle only.
- Models and caches remain in `/sdcard/termux-os/models/` and `/sdcard/termux-os/caches/`.

## Before the next release

1. Run `npm test`, `npm run public:export`, and `npm run public:check` from the Framework source.
2. Sync only `tmp/public-tree` into a separate staging clone; never publish the local source tree wholesale.
3. Review the allowlist diff and run the GitHub Actions CI before moving a release tag.
4. Publish only a tested tag and attach deterministic artifacts with SHA-256 sidecars.
5. Keep the two newest verified Framework versions in the Cloudflare Registry and revoke older entries before the next release.
