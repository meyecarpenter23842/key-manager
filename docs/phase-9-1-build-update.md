# Phase 9.1 — Build, local update, and bundled Admin API

Phase 9.1 replaces the manual Key Manager release flow introduced in Phase 9 while leaving external application R2 publishing unchanged.

## Key Manager local release flow

The normal OWNER flow is now:

1. Open **Build & Update**.
2. Enter a new SemVer version and release notes.
3. Click **Đóng gói bản mới** once.

The native release command then:

1. validates that the requested version is greater than the source version;
2. requires `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and root `package.json` to agree before changing anything;
3. snapshots those files plus `src-tauri/Cargo.lock` for rollback;
4. updates the three source versions;
5. runs the configured NSIS build command;
6. copies only installers whose filename contains the requested version into a private staging directory;
7. computes and verifies size/SHA-256 metadata;
8. writes `release.json` in staging;
9. renames staging to `<update-root>/<version>` only after verification;
10. writes `latest.json` last.

An already-published `<version>` directory is rejected. If build or publish fails before completion, source version files are restored from the snapshot and staging is removed.

`schemaVersion` remains `1`. `releaseNotes` is an additive field so existing Phase 9 readers continue to accept the manifest.

## Bundled Admin API sidecar

The Windows desktop build packages `server/src/index.mjs` into a self-contained `key-manager-api.exe` using pinned `@yao-pkg/pkg@6.22.0` at build time. Tauri includes it through `bundle.externalBin`.

The installed application does **not** require Node.js or pnpm. On launch the Rust host:

- checks `http://127.0.0.1:3101/health` first;
- does not spawn a second API if a healthy instance is already running;
- otherwise starts the bundled sidecar without a terminal window;
- forces the local host/port and allows the two desktop origins `http://localhost:1420` and `http://tauri.localhost`;
- records sidecar stdout/stderr in the Tauri app log directory;
- terminates only the sidecar process it owns when Key Manager exits.

This keeps API/database access behind the Admin API process. Database credentials and signing secrets are never compiled into React/Vite variables.

## Server-only runtime configuration

The sidecar obtains `DATABASE_URL` and other server-only settings from the first applicable source below:

1. `KEY_MANAGER_ADMIN_API_ENV_FILE`, when explicitly set;
2. `%APPDATA%\\com.keymanager.desktop\\admin-api.env`;
3. the project-root `.env` file on the build/development machine;
4. environment variables inherited by Key Manager.

The environment file uses simple `KEY=VALUE` lines. `VITE_*` entries are ignored by the sidecar loader.

For the current local Windows setup, a minimal file is:

```text
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/key_manager_dev
```

Do not put server secrets into `VITE_*` variables.

## Build machine

The first Tauri dev/build run may download the pinned pkg tool/runtime through `pnpm dlx`. Generated sidecar executables under `src-tauri/binaries/` are build outputs and are gitignored.

```powershell
pnpm desktop:prepare-sidecar
pnpm tauri dev
pnpm tauri build --bundles nsis
```

`beforeDevCommand` and `beforeBuildCommand` already call `desktop:prepare-sidecar`, so the explicit preparation command is only useful for troubleshooting.

## Required verification

Before merge, run frontend lint/typecheck/tests/build, Rust format/check/tests, Admin API integration tests, and the Windows Tauri build check. After merge, perform the real `0.1.0 -> 0.1.1` installer/update flow from issue #17 and verify that opening Key Manager from its shortcut starts the API without a separate terminal.
