## Installation

This fork ships two Windows x64 builds. Both use the same app identifier (`com.tizu.markdown`), so they share settings and data.

| File | What it is | How to install |
|------|-----------|----------------|
| `TizuMark_<version>_x64-setup.exe` | NSIS installer | Run it. Recommended. |
| `TizuMark_<version>_x64.exe` | Portable, no installer | Run it directly. Nothing is written to the registry. |

### Upgrading from an earlier build

- **Installed with the `.exe` setup:** Run the new setup over the existing install. It replaces the files in the same folder. You do not need to uninstall first.
- **Installed with the `.msi` package:** Uninstall the old version from *Settings → Apps → Installed apps* first. Otherwise two TizuMark entries can appear.
- **Portable build:** Replace the old `.exe` with the new one. It uses the same data folder as the installed version.

### Your data

Settings, autosave snapshots and recent files are kept in `%APPDATA%\com.tizu.markdown`. Upgrading does not delete that folder. To be safe, back it up before upgrading.

### Updates

- **In-app auto-update is disabled** in these builds. The updater key belongs to the upstream project, so this fork cannot sign updates for it.
- Check this Releases page for newer versions.
- Builds are **unsigned**, so Windows SmartScreen may warn on first run. Choose *More info → Run anyway* if you trust the source.
