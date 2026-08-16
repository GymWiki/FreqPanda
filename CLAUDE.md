# Desktop app versioning

Whenever a change touches `src-tauri/` (the Tauri desktop app — Rust code,
`tauri.conf.json`, icons, capabilities, or anything else that changes what
ships in a build), bump the version yourself as part of that change —
don't wait to be asked, and don't leave it for the user to remember.

Both of these must be bumped together, to the same value:

- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`

Default to a patch bump (`0.1.0` → `0.1.1`) for an ordinary fix or small
change. Use a minor bump for a real new feature, major only if the user
says so explicitly.

This matters beyond bookkeeping: the desktop app's self-updater
(`src-tauri/src/main.rs`, `plugins.updater` in `tauri.conf.json`) compares
its own build-time version against the latest published GitHub Release to
decide whether an update exists. Shipping a new build without bumping the
version means existing installs will never see it as an update.

Building and publishing a new desktop release itself (running
`.github/workflows/release-desktop-app.yml`, either via a pushed `app-v*`
tag or a manual `workflow_dispatch`) is a separate step — bumping the
version here doesn't trigger it, it just makes the *next* build
identifiable and updatable. Do that when the user asks for a new release,
using the bumped version as the tag (e.g. `app-v0.1.1`).
