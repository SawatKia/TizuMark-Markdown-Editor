# Decisions

Record of the decisions made while setting up this fork, with the reason for each. Newest decisions go at the bottom.

## 2026-10-25

### 1. Work on a fork instead of the upstream repo
- **Decision:** Development and releases happen in `SawatKia/TizuMark-Markdown-Editor`.
- **Why:** The account has no write access to `tizuio/TizuMark-Markdown-Editor` (push returned 403).
- **Remotes:** `fork` = `SawatKia/...` (the one we push to). `origin` = `tizuio/...` (read-only upstream).

### 2. Keep the original app name, identifier and update system
- **Decision:** `productName` (TizuMark) and `identifier` (`com.tizu.markdown`) are unchanged. The updater `pubkey` and `endpoints` still point to upstream.
- **Why:** The user asked to keep the original name and update system.
- **Consequence:** In-app auto-update is effectively off. The updater cannot verify our builds because we do not hold the upstream private key. Users must download new versions from the fork's Releases page.

### 3. Release builds are unsigned
- **Decision:** The Windows build is not signed with the updater key (`createUpdaterArtifacts` is not set, so no signature is needed).
- **Why:** We do not have the upstream signing key or password. Creating our own key would change `pubkey`, which conflicts with decision 2.
- **Consequence:** Windows SmartScreen may warn on first run.

### 4. Version scheme: SemVer, bumped by automation
- **Decision:** Versions follow SemVer. The first fork release is `1.3.0` (new features on top of `1.2.4`). Each automated sync bumps `patch` by default. `minor` and `major` can be chosen when the workflow is run manually.
- **Why:** The user asked for SemVer and a fully automatic release.
- **Tooling:** `scripts/bump-version.cjs` updates all 9 version locations that `scripts/check-version.mjs` verifies.

### 5. Automated upstream sync and release
- **Decision:** `.github/workflows/sync-upstream.yml` runs daily at 03:17 UTC and can also be started manually.
  1. Fetch `upstream/master`. If there are no new commits, stop.
  2. Try a normal merge. **No conflict resolution is automated.**
  3. If the merge conflicts: abort, open a GitHub issue, and stop. Nothing is pushed or released.
  4. If the merge is clean: run `npm run check`, `npm test`, bump the version, and build with `npm run build`.
  5. Only after a successful build: commit, tag `vX.Y.Z`, push, and create the GitHub Release with the `.exe` files.
- **Why:** Automatic conflict resolution can silently pick the wrong side when both sides edit the same logic. A failed build should never publish. Tests are a gate, not optional.
- **Consequence:** A conflict needs a human. Until the fork's `master` contains upstream again, the next run is a no-op.

### 6. Documentation language: English
- **Decision:** `README.md` and `README.en.md` are English. The Chinese README moved to `README.zh-CN.md`. `README.es.md` is unchanged except for the language-switcher link.
- **Why:** The user asked for English. `check-version` still expects `README.en.md`, so it was kept.
- **Note:** If upstream changes `README.md`, the next sync will conflict on that file. The conflict issue will flag it.

## Known risks and open items

- **Secrets in `CLAUDE.md`:** It still contains the upstream signing password and private-key path in plain text. Since this repo is public, those lines should be removed. Not done yet, because editing that file needs the user's approval.
- **Duplicate builds:** `.github/workflows/build-windows.yml` also runs on every push to `master`, so each sync can build twice. Not changed yet.
- **First real sync not yet tested:** The no-op path was tested (run `40192273166`, success). The merge → build → release path runs for the first time when upstream has new commits.
- **Actions on forks:** Workflows must be enabled in the fork's Actions tab.

## How to undo

- Stop automation: disable the "Sync upstream and release" workflow in the Actions tab, or delete `.github/workflows/sync-upstream.yml`.
- Remove a bad release: delete it on the fork's Releases page and delete its tag. Only the fork's Releases are affected.
