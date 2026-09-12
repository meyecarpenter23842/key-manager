# Phase 9 — Build & Release Updater

Phase 9 adds an OWNER-only local release manager inside Key Manager Desktop.

## Two publication flows

### Key Manager itself — local

Default configuration:

- Source: `F:\1_A_Disk_D\key-manager`
- Build: `pnpm tauri build --bundles nsis`
- Build output: `src-tauri\target\release\bundle\nsis`
- Local update repository: `F:\key-manager\update`

The current flow asks for the new SemVer and release notes, updates the Key Manager source metadata, builds the NSIS installer, stages a complete version directory, then writes the local `latest.json` pointer last. Source version files are restored when packaging fails before the release is committed.

A packaged Key Manager build can check `latest.json`. If a newer version exists, the native layer verifies the installer SHA-256, launches the bundled `self-update.ps1`, exits Key Manager, installs silently, and relaunches the application. Self-install is intentionally blocked in debug/dev builds.

## Other Desktop Apps — Cloudflare R2

Each application has fixed local release configuration containing:

- source folder
- build command
- build output folder
- JSON version file + version field
- artifact patterns
- manifest/publish-pointer patterns
- R2 bucket and optional prefix
- optional binding to one locally encrypted R2 credential profile

The profile is stored only in Key Manager's OS application config directory, not PostgreSQL. New version and release notes are release-time inputs and are deliberately not stored in this configuration modal.

### External publish flow

`get_external_release_status` reads the configured source version before the publish form opens. `package_external_release` then performs these stages:

1. `VERSION` — validate strict SemVer and require the requested version to be newer than the source version.
2. `BUILD` — bump the configured JSON version field, synchronize a matching Flutter `pubspec.yaml` build-name when present, then run the configured build command.
3. `VALIDATE` — require release artifacts and at least one manifest/publish pointer. JSON manifests and Electron Builder YAML manifests are checked against the requested version; compatible JSON `releaseNotes`, `message`, or `notes` fields receive the entered release notes. If the output contains versioned artifacts but none match the requested release, validation fails instead of publishing stale installers.
4. `UPLOAD_ARTIFACT` — upload ordinary artifacts first.
5. `UPLOAD_MANIFEST` — upload manifest/publish-pointer files last.
6. `COMPLETE` — return application, version, R2 destination, uploaded files, build output and uploader output.

The build child process receives `KM_RELEASE_VERSION` and `KM_RELEASE_NOTES`. App-specific build scripts may consume these values when they need extra release metadata beyond the configured JSON version field. For Flutter sources, Key Manager preserves the existing `+buildNumber` while synchronizing the `pubspec.yaml` version name.

If `BUILD`, `VALIDATE`, or R2 upload fails, the configured source version metadata is restored. Build stdout/stderr and uploader stdout/stderr are retained in the returned error, so the Build / Publish log remains useful on failed commands.

Build output folders can contain stale installers from older releases. The external flow publishes artifacts for the requested version plus unversioned support files, filters older versioned artifacts, and fails validation when it finds only stale versioned builds.

### R2 credentials and atomic publish

A bound local credential profile is resolved before source mutation or build. The existing credential contract is unchanged:

- Account ID / Access Key ID / Secret Access Key are stored per R2 profile.
- Secrets are protected with Windows DPAPI and are not returned to React.
- An application may bind to its own R2 credential profile.
- When no profile is bound, CI/environment fallback remains `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`.
- Credentials are injected only into the uploader child process.

The bundled uploader still receives all selected files and independently orders files matching `manifestPatterns` last. Therefore a failed installer/artifact upload cannot advance `latest.json`, `latest.yml`, or another configured publish pointer. A failed manifest upload can leave an orphaned versioned artifact in R2, but clients keep seeing the previous publish pointer and the source version is rolled back for a safe retry.

## Trust and safety boundaries

- Build commands are arbitrary local developer commands and the UI is exposed only to OWNER.
- External source/output paths must exist before build artifacts are accepted.
- External release versions use strict `major.minor.patch` SemVer with normal prerelease support; build metadata (`+...`) is rejected for release versions.
- Configured JSON version fields are changed in place rather than reserializing the complete source file.
- Key Manager local update versions and installer names reject path traversal.
- Local self-update verifies SHA-256 immediately before starting the installer.
- R2 credentials remain outside the frontend and outside the database.
- No database migration is required because build/release profiles remain machine-local operator configuration.

## Test flow — SALON

With the existing SALON profile:

- Source: `F:\1_A_Disk_D\Tool\Hair_Spa_Manager`
- Build: `npm run package:update`
- Build output: `dist\windows-release`
- Version file/field: `package.json` / `version`
- Artifacts: `Salon-Setup-*.exe`, `latest.json`
- Publish pointer: `latest.json`
- R2 bucket: `beauty-salon`
- R2 prefix: empty

Open **Build & Update**, choose SALON, then **Phát hành R2**. Confirm the source version shown, enter a newer SemVer and release notes, then publish. A successful `1.8.1` release should show `Salon-Setup-1.8.1.exe` followed by `latest.json` in the result and R2 destination `r2://beauty-salon`.

For a negative test, use an invalid/unauthorized R2 credential profile. The build may finish locally, but the log must still show the successful build/validation stages followed by the exact failed upload stage and the uploader HTTP error. `latest.json` must not be advanced when the installer upload fails.
