---
name: fork-release
description: Release TizuMark from the fork (SawatKia/TizuMark-Markdown-Editor) — bump SemVer, verify, build the Windows x64 installer and portable exe, tag, and publish a GitHub Release with install notes. Use when the user says release, publish, new version, or asks for a compiled download for this fork. Not for the upstream Gitee/GitHub release flow (that is the tizu-release skill).
---

# fork-release

Release the fork. Its builds are unsigned and auto-update is off (see `decisions.md`).

## Red lines

- Build and push only when the user has asked for it in this request. Confirm the version before pushing.
- Never delete a published Release or tag. To remove one, tell the user to delete it on the Releases page.
- Never write the upstream signing password or key path into any file or release.

## Steps

1. **Check state.** `git status` must be clean (or only the intended changes). Confirm the branch is `master` and `fork` is `SawatKia/TizuMark-Markdown-Editor`.
2. **Choose the version.** Read `package.json`. Use SemVer:
   - `patch` for fixes only, `minor` for new features, `major` for breaking changes.
   - Ask the user if the choice is unclear.
3. **Bump.** `node scripts/bump-version.cjs <x.y.z>`, then `node scripts/check-version.mjs`. Both must pass.
4. **Verify.** `npm run check`, then the tests related to the change. Run `npm test` only if the user asks, or before a release that touches many modules.
5. **Build.** `npm run build` (runs `build:renderer` and `tauri build`). Outputs:
   - `src-tauri/target/release/bundle/nsis/TizuMark_<v>_x64-setup.exe`
   - `src-tauri/target/release/TizuMark_<v>_x64.exe`
6. **Commit and tag.** Commit with a Chinese conventional message that includes the Co-Authored-By line. Then `git tag -a v<v> -m "TizuMark v<v>"`.
7. **Push.** `git push fork master v<v>`. Ask the user before this step.
8. **Publish.** Build the notes file, then create the release:
   ```
   { echo "<one-line summary of changes in English>"; echo; cat docs/release-install-notes.md; } > notes.md
   gh release create v<v> --repo SawatKia/TizuMark-Markdown-Editor --title "TizuMark v<v>" --notes-file notes.md <setup.exe> <portable.exe>
   ```
   Delete `notes.md` afterwards.
9. **Verify.** `gh release view v<v> --repo SawatKia/TizuMark-Markdown-Editor --json assets` must list both files with the expected sizes.

## Install notes

`docs/release-install-notes.md` is the single source for the install section. It must stay accurate:
- `.exe` setup upgrades in place. `.msi` installs must be uninstalled first.
- The portable exe shares data with the installed build (same identifier `com.tizu.markdown`).
- Data lives in `%APPDATA%\com.tizu.markdown`.
- Auto-update is disabled and builds are unsigned.

If the identifier, product name or updater setup changes, update that file first, then this skill.

## Automated releases

`.github/workflows/sync-upstream.yml` runs the same steps daily when upstream has new commits. It uses `docs/release-install-notes.md` too. Do not run both for the same version.
