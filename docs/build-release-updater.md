# Phase 9 — Build & Release Updater

Phase 9 adds an OWNER-only local release manager inside Key Manager Desktop.

## Two publication flows

### Key Manager itself — local

Default configuration:

- Source: `F:\1_A_Disk_D\key-manager`
- Build: `pnpm tauri build --bundles nsis`
- Build output: `src-tauri\target\release\bundle\nsis`
- Local update repository: `F:\key-manager\update`

Packaging reads the version from `src-tauri/tauri.conf.json`, copies the generated NSIS installer into
`<update-root>\<version>\`, computes SHA-256, and writes `<update-root>\latest.json`.

A packaged Key Manager build can check `latest.json`. If a newer version exists, the native layer verifies
the installer SHA-256, launches the bundled `self-update.ps1`, exits Key Manager, installs silently, and
relaunches the application. Self-install is intentionally blocked in debug/dev builds.

## Other Desktop Apps — Cloudflare R2

Each application can have a local release profile containing:

- source folder
- build command
- build output folder
- JSON version file + version field
- artifact patterns
- manifest/publish-pointer patterns
- R2 bucket and optional prefix

The profile is stored only in Key Manager's OS application config directory, not PostgreSQL.

`package_external_application` runs the configured build from the source directory, verifies expected
artifacts, then invokes the bundled Node uploader. The uploader reads credentials only from the Key Manager
process environment:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Credentials are never persisted in React state, VITE variables, PostgreSQL, or the release profile.

The R2 uploader uploads ordinary artifacts first and files matching `manifestPatterns` last. For Electron
Builder feeds such as PageAuto this means installer/blockmap first and `latest.yml` last, preventing clients
from observing a publish pointer before its artifacts exist.

## Trust and safety boundaries

- Build commands are arbitrary local developer commands and the UI is exposed only to OWNER.
- External source/output paths must exist before build artifacts are accepted.
- Key Manager local update versions and installer names reject path traversal.
- Local self-update verifies SHA-256 immediately before starting the installer.
- R2 credentials remain outside the frontend and outside the database.
- No database migration is required for Phase 9 because build/release profiles are machine-local operator
  configuration, not central license data.

## Test flow

1. Start the Admin API and Key Manager with an OWNER account.
2. Open **Build & Update**.
3. Confirm the Key Manager source/build/output/update paths and save.
4. Bump `src-tauri/tauri.conf.json` to the intended release version before packaging.
5. Click **Đóng gói bản hiện tại**.
6. Verify `<update-root>\<version>\*.exe` and `<update-root>\latest.json`.
7. Install/run the previous packaged Key Manager version and click **Kiểm tra cập nhật** then **Cập nhật**.
8. For another app, configure source/build/output/version/artifact/manifest/R2 fields.
9. Export the three R2 credential environment variables, then click **Đóng gói & Upload R2**.
10. Verify the release artifacts exist in R2 and that the manifest/publish pointer was uploaded last.
