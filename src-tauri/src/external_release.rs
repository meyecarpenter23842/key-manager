use crate::{
    r2_credentials,
    release_manager::{ExternalReleaseProfile, PackageResult, ReleaseArtifact},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use tauri::{AppHandle, Manager};

const R2_ACCOUNT_ENV: &str = "R2_ACCOUNT_ID";
const R2_ACCESS_ENV: &str = "R2_ACCESS_KEY_ID";
const R2_SECRET_ENV: &str = "R2_SECRET_ACCESS_KEY";
const RELEASE_VERSION_ENV: &str = "KM_RELEASE_VERSION";
const RELEASE_NOTES_ENV: &str = "KM_RELEASE_NOTES";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReleaseStatus {
    pub application_id: String,
    pub app_code: String,
    pub current_version: String,
    pub destination: String,
}

struct SourceBackup {
    files: Vec<(PathBuf, Vec<u8>)>,
}

impl SourceBackup {
    fn capture(paths: &[PathBuf]) -> Result<Self, String> {
        let mut files = Vec::new();
        for path in paths {
            if path.is_file() {
                files.push((
                    path.clone(),
                    fs::read(path).map_err(|error| {
                        format!("SOURCE_BACKUP_READ_FAILED: {}: {error}", path.display())
                    })?,
                ));
            }
        }
        Ok(Self { files })
    }

    fn restore(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        for (path, contents) in &self.files {
            if let Err(error) = fs::write(path, contents) {
                failures.push(format!("{}: {error}", path.display()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("SOURCE_ROLLBACK_FAILED: {}", failures.join("; ")))
        }
    }
}

#[tauri::command]
pub(crate) fn get_external_release_status(
    app: AppHandle,
    application_id: String,
) -> Result<ExternalReleaseStatus, String> {
    let profile = load_profile(&app, &application_id)?;
    validate_profile(&profile)?;
    let source = canonical_existing_dir(Path::new(&profile.source_dir), "application source")?;
    let version_file = resolve_path(&source, &profile.version_file);
    let current_version =
        normalize_semver(&read_json_string(&version_file, &profile.version_field)?)?;
    validate_flutter_version_mirror(&source, &current_version)?;
    let destination = destination_for(&profile);

    Ok(ExternalReleaseStatus {
        application_id,
        app_code: profile.app_code,
        current_version,
        destination,
    })
}

#[tauri::command]
pub(crate) fn package_external_release(
    app: AppHandle,
    application_id: String,
    new_version: String,
    release_notes: String,
) -> Result<PackageResult, String> {
    let profile = load_profile(&app, &application_id)?;
    validate_profile(&profile)?;

    // Resolve credentials before mutating source or starting an expensive build.
    // A saved DPAPI profile wins; no binding preserves the existing CI/env fallback.
    let credential_profile = r2_credentials::resolve_for_application(&app, &application_id)?;
    if credential_profile.is_none() {
        for required in [R2_ACCOUNT_ENV, R2_ACCESS_ENV, R2_SECRET_ENV] {
            if std::env::var_os(required).is_none() {
                return Err(format!(
                    "R2_CREDENTIAL_MISSING: no saved R2 profile is selected and environment variable {required} is not set"
                ));
            }
        }
    }

    let source = canonical_existing_dir(Path::new(&profile.source_dir), "application source")?;
    let version_file = resolve_path(&source, &profile.version_file);
    let current_version =
        normalize_semver(&read_json_string(&version_file, &profile.version_field)?)?;
    validate_flutter_version_mirror(&source, &current_version)?;

    let version = normalize_semver(&new_version)?;
    ensure_newer_version(&version, &current_version)?;
    let notes = release_notes.trim().to_string();
    if notes.is_empty() {
        return Err("RELEASE_NOTES_REQUIRED: release notes cannot be empty".to_string());
    }

    let pubspec = source.join("pubspec.yaml");
    let backup_paths = if pubspec.is_file() {
        vec![version_file.clone(), pubspec.clone()]
    } else {
        vec![version_file.clone()]
    };
    let backup = SourceBackup::capture(&backup_paths)?;

    if let Err(error) = replace_json_string_field(
        &version_file,
        &profile.version_field,
        &current_version,
        &version,
    ) {
        return Err(with_rollback(Vec::new(), "VERSION", error, &backup));
    }
    if pubspec.is_file() {
        if let Err(error) = sync_flutter_pubspec(&pubspec, &current_version, &version) {
            return Err(with_rollback(Vec::new(), "VERSION", error, &backup));
        }
    }

    let mut log = vec![stage_ok(
        "VERSION",
        &format!("{} -> {}", current_version, version),
    )];

    let build = match run_shell(&profile.build_command, &source, &version, &notes) {
        Ok(output) => output,
        Err(error) => return Err(with_rollback(log, "BUILD", error, &backup)),
    };
    let build_output = combined_output(&build);
    if !build.status.success() {
        log.push(stage_fail(
            "BUILD",
            &format!("{} exited with {}", profile.app_code, exit_code(&build)),
        ));
        push_output(&mut log, &build_output);
        return Err(rollback_log(log, &backup));
    }
    log.push(stage_ok("BUILD", &profile.app_code));
    push_output(&mut log, &build_output);

    let output_dir = resolve_path(&source, &profile.output_dir);
    let artifacts = match validate_and_prepare_artifacts(&output_dir, &profile, &version, &notes) {
        Ok(artifacts) => artifacts,
        Err(error) => return Err(with_rollback(log, "VALIDATE", error, &backup)),
    };
    let manifest_count = artifacts
        .iter()
        .filter(|path| is_manifest(path, &profile.manifest_patterns))
        .count();

    let release_artifacts = match collect_release_artifacts(&artifacts) {
        Ok(release_artifacts) => release_artifacts,
        Err(error) => return Err(with_rollback(log, "VALIDATE", error, &backup)),
    };
    log.push(stage_ok(
        "VALIDATE",
        &format!(
            "{} files; {} publish pointer(s)",
            artifacts.len(),
            manifest_count
        ),
    ));

    let ordered = order_uploads(&artifacts, &profile.manifest_patterns);
    let uploader = match resource_file(&app, "r2-upload.mjs") {
        Ok(path) => path,
        Err(error) => return Err(with_rollback(log, "UPLOAD_ARTIFACT", error, &backup)),
    };
    let uploader_for_node = node_compatible_path(&uploader);
    let node_cwd = node_compatible_path(&source);
    let mut command = Command::new("node");
    command.arg(&uploader_for_node);
    command.arg("--bucket").arg(&profile.r2_bucket);
    command.arg("--prefix").arg(&profile.r2_prefix);
    for pattern in &profile.manifest_patterns {
        command.arg("--manifest").arg(pattern);
    }
    for (artifact, _) in &ordered {
        command.arg("--file").arg(node_compatible_path(artifact));
    }
    if let Some(credentials) = credential_profile {
        // Secrets remain scoped to the uploader child process only.
        command.env(R2_ACCOUNT_ENV, credentials.account_id);
        command.env(R2_ACCESS_ENV, credentials.access_key_id);
        command.env(R2_SECRET_ENV, credentials.secret_access_key);
    }

    let upload = match command.current_dir(&node_cwd).output() {
        Ok(output) => output,
        Err(error) => {
            let stage = ordered
                .first()
                .map(|(_, manifest)| upload_stage(*manifest))
                .unwrap_or("UPLOAD_ARTIFACT");
            return Err(with_rollback(
                log,
                stage,
                format!("R2_UPLOADER_START_FAILED: {error}"),
                &backup,
            ));
        }
    };
    let upload_output = combined_output(&upload);
    let upload_stages = upload_stage_lines(&ordered, &upload_output, upload.status.success());
    log.extend(upload_stages);
    push_output(&mut log, &upload_output);
    if !upload.status.success() {
        log.push(format!(
            "R2_UPLOAD_FAILED: uploader exited with {}",
            exit_code(&upload)
        ));
        return Err(rollback_log(log, &backup));
    }

    let destination = destination_for(&profile);
    log.push(stage_ok(
        "COMPLETE",
        &format!("{} {} -> {}", profile.app_code, version, destination),
    ));

    Ok(PackageResult {
        app_code: profile.app_code,
        version,
        destination,
        artifacts: release_artifacts,
        log: log.join("\n"),
    })
}

fn load_profile(app: &AppHandle, application_id: &str) -> Result<ExternalReleaseProfile, String> {
    let config = crate::release_manager::get_release_manager_config(app.clone())?;
    config
        .external_profiles
        .into_iter()
        .find(|profile| profile.application_id == application_id)
        .ok_or_else(|| "RELEASE_PROFILE_NOT_FOUND: configure this application first".to_string())
}

fn validate_profile(profile: &ExternalReleaseProfile) -> Result<(), String> {
    if profile.application_id.trim().is_empty()
        || profile.app_code.trim().is_empty()
        || profile.source_dir.trim().is_empty()
        || profile.build_command.trim().is_empty()
        || profile.output_dir.trim().is_empty()
        || profile.version_file.trim().is_empty()
        || profile.version_field.trim().is_empty()
        || profile.r2_bucket.trim().is_empty()
    {
        return Err(format!(
            "RELEASE_PROFILE_INVALID: {} has missing required fields",
            profile.app_code
        ));
    }
    if profile.artifact_patterns.is_empty() {
        return Err(format!(
            "RELEASE_PROFILE_INVALID: {} needs at least one artifact pattern",
            profile.app_code
        ));
    }
    if profile.manifest_patterns.is_empty() {
        return Err(format!(
            "RELEASE_PROFILE_INVALID: {} needs manifestPatterns so the publish pointer is uploaded last",
            profile.app_code
        ));
    }
    if profile
        .r2_prefix
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(
            "RELEASE_PROFILE_INVALID: R2 prefix cannot contain . or .. segments".to_string(),
        );
    }
    Ok(())
}

fn validate_and_prepare_artifacts(
    output_dir: &Path,
    profile: &ExternalReleaseProfile,
    version: &str,
    release_notes: &str,
) -> Result<Vec<PathBuf>, String> {
    let all = collect_matching_files(output_dir, &profile.artifact_patterns)?;
    if all.is_empty() {
        return Err(format!(
            "ARTIFACT_NOT_FOUND: patterns {:?} matched nothing under {}",
            profile.artifact_patterns,
            output_dir.display()
        ));
    }

    let mut manifests = Vec::new();
    let mut ordinary = Vec::new();
    for path in all {
        if is_manifest(&path, &profile.manifest_patterns) {
            manifests.push(path);
        } else {
            ordinary.push(path);
        }
    }
    if manifests.is_empty() {
        return Err(
            "PUBLISH_POINTER_NOT_FOUND: none of manifestPatterns matched a build artifact"
                .to_string(),
        );
    }
    if ordinary.is_empty() {
        return Err("ARTIFACT_NOT_FOUND: release has no non-manifest artifact".to_string());
    }

    // Build outputs often retain installers from older versions. Keep the
    // requested release plus unversioned support files, but never fall back to
    // stale versioned artifacts when the requested build is missing.
    ordinary = select_release_artifacts(ordinary, version)?;

    for manifest in &manifests {
        prepare_manifest(manifest, version, release_notes)?;
    }

    let mut selected = ordinary;
    selected.extend(manifests);
    selected.sort();
    Ok(selected)
}

fn select_release_artifacts(ordinary: Vec<PathBuf>, version: &str) -> Result<Vec<PathBuf>, String> {
    let mut requested = Vec::new();
    let mut unversioned = Vec::new();
    let mut stale_versioned = Vec::new();

    for path in ordinary {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name.contains(version) {
            requested.push(path);
        } else if contains_numeric_semver(name) {
            stale_versioned.push(path);
        } else {
            unversioned.push(path);
        }
    }

    if requested.is_empty() && !stale_versioned.is_empty() {
        let found = stale_versioned
            .iter()
            .filter_map(|path| path.file_name().and_then(|value| value.to_str()))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "ARTIFACT_VERSION_MISMATCH: no versioned artifact for release {version}; found only stale versioned artifacts: {found}"
        ));
    }

    requested.extend(unversioned);
    requested.sort();
    Ok(requested)
}

fn contains_numeric_semver(value: &str) -> bool {
    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() {
            continue;
        }
        let mut cursor = start;
        for part in 0..3 {
            let digit_start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            if cursor == digit_start {
                break;
            }
            if part < 2 {
                if cursor >= bytes.len() || bytes[cursor] != b'.' {
                    break;
                }
                cursor += 1;
            } else {
                return true;
            }
        }
    }
    false
}

fn prepare_manifest(path: &Path, version: &str, release_notes: &str) -> Result<(), String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("json") => prepare_json_manifest(path, version, release_notes),
        Some("yml") | Some("yaml") => validate_yaml_manifest(path, version),
        _ => Ok(()),
    }
}

fn validate_yaml_manifest(path: &Path, version: &str) -> Result<(), String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("MANIFEST_READ_FAILED: {}: {error}", path.display()))?;
    let mut found_version = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("version:") {
            let found = value.trim().trim_matches(['"', '\'']);
            if !found.is_empty() {
                found_version = true;
                if found != version {
                    return Err(format!(
                        "MANIFEST_VERSION_MISMATCH: {} version={} but release version is {}",
                        path.display(),
                        found,
                        version
                    ));
                }
            }
        }

        if let Some(value) = trimmed.strip_prefix("path:") {
            let artifact = value.trim().trim_matches(['"', '\'']);
            if !artifact.is_empty()
                && contains_numeric_semver(artifact)
                && !artifact.contains(version)
            {
                return Err(format!(
                    "MANIFEST_ARTIFACT_MISMATCH: {} path={} does not reference release {}",
                    path.display(),
                    artifact,
                    version
                ));
            }
        }
    }

    if !found_version {
        return Err(format!(
            "MANIFEST_VERSION_NOT_FOUND: {} has no version field",
            path.display()
        ));
    }
    Ok(())
}

fn collect_release_artifacts(paths: &[PathBuf]) -> Result<Vec<ReleaseArtifact>, String> {
    paths
        .iter()
        .map(|path| {
            let metadata = fs::metadata(path).map_err(|error| {
                format!("ARTIFACT_METADATA_FAILED: {}: {error}", path.display())
            })?;
            Ok(ReleaseArtifact {
                name: file_name_string(path)?,
                path: path.display().to_string(),
                size: metadata.len(),
            })
        })
        .collect()
}

fn prepare_json_manifest(path: &Path, version: &str, release_notes: &str) -> Result<(), String> {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Ok(());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("MANIFEST_READ_FAILED: {}: {error}", path.display()))?;
    let mut value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("MANIFEST_PARSE_FAILED: {}: {error}", path.display()))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("MANIFEST_INVALID: {} must be a JSON object", path.display()))?;

    for field in ["latestVersion", "version"] {
        if let Some(found) = object.get(field).and_then(Value::as_str) {
            if found.trim() != version {
                return Err(format!(
                    "MANIFEST_VERSION_MISMATCH: {} {}={} but release version is {}",
                    path.display(),
                    field,
                    found,
                    version
                ));
            }
        }
    }

    if let Some(field) = object.get_mut("releaseNotes") {
        if field.is_string() {
            *field = Value::String(release_notes.to_string());
        }
    } else if let Some(field) = object.get_mut("message") {
        if field.is_string() {
            *field = Value::String(release_notes.to_string());
        }
    } else if let Some(field) = object.get_mut("notes") {
        if field.is_string() {
            *field = Value::String(release_notes.to_string());
        } else if field.is_array() {
            *field = Value::Array(vec![Value::String(release_notes.to_string())]);
        }
    }

    if let Some(download) = object.get("downloadPath").and_then(Value::as_str) {
        let file_name = Path::new(download)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if file_name.is_empty() || !file_name.contains(version) {
            return Err(format!(
                "MANIFEST_ARTIFACT_MISMATCH: {} downloadPath={} does not reference release {}",
                path.display(),
                download,
                version
            ));
        }
    }

    let mut updated = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("MANIFEST_SERIALIZE_FAILED: {error}"))?;
    updated.push(b'\n');
    fs::write(path, updated)
        .map_err(|error| format!("MANIFEST_WRITE_FAILED: {}: {error}", path.display()))
}

fn validate_flutter_version_mirror(source: &Path, current: &str) -> Result<(), String> {
    let pubspec = source.join("pubspec.yaml");
    if !pubspec.is_file() {
        return Ok(());
    }
    let flutter = read_pubspec_version(&pubspec)?;
    if flutter != current {
        return Err(format!(
            "SOURCE_VERSION_MISMATCH: {}={} but configured release version is {}",
            pubspec.display(),
            flutter,
            current
        ));
    }
    Ok(())
}

fn read_pubspec_version(path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("version:") {
            let value = rest.split('#').next().unwrap_or_default().trim();
            let name = value.split_once('+').map(|(name, _)| name).unwrap_or(value);
            return normalize_semver(name);
        }
    }
    Err(format!(
        "VERSION_FIELD_NOT_FOUND: version not found in {}",
        path.display()
    ))
}

fn sync_flutter_pubspec(path: &Path, expected: &str, next: &str) -> Result<(), String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let mut offset = 0usize;
    for line in raw.split_inclusive('\n') {
        let line_without_newline = line.trim_end_matches(['\r', '\n']);
        let trimmed = line_without_newline.trim_start();
        if let Some(rest) = trimmed.strip_prefix("version:") {
            let value = rest.split('#').next().unwrap_or_default().trim();
            let (name, suffix) = value
                .split_once('+')
                .map(|(name, build)| (name, format!("+{build}")))
                .unwrap_or((value, String::new()));
            if normalize_semver(name)? != expected {
                return Err(format!(
                    "SOURCE_VERSION_MISMATCH: {}={} but expected {}",
                    path.display(),
                    name,
                    expected
                ));
            }
            let local = line
                .find(value)
                .ok_or_else(|| format!("VERSION_FIELD_INVALID: {}", path.display()))?;
            let start = offset + local;
            let end = start + value.len();
            let mut updated = String::with_capacity(raw.len() + next.len());
            updated.push_str(&raw[..start]);
            updated.push_str(next);
            updated.push_str(&suffix);
            updated.push_str(&raw[end..]);
            return fs::write(path, updated).map_err(|error| {
                format!("VERSION_FILE_WRITE_FAILED: {}: {error}", path.display())
            });
        }
        offset += line.len();
    }
    Err(format!(
        "VERSION_FIELD_NOT_FOUND: version not found in {}",
        path.display()
    ))
}

fn read_json_string(path: &Path, field: &str) -> Result<String, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("VERSION_FILE_PARSE_FAILED: {}: {error}", path.display()))?;
    let mut current = &value;
    for segment in field.split('.') {
        current = current.get(segment).ok_or_else(|| {
            format!(
                "VERSION_FIELD_NOT_FOUND: {field} not found in {}",
                path.display()
            )
        })?;
    }
    current
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("VERSION_FIELD_INVALID: {field} must be a non-empty string"))
}

fn replace_json_string_field(
    path: &Path,
    field: &str,
    expected: &str,
    next: &str,
) -> Result<(), String> {
    let actual = normalize_semver(&read_json_string(path, field)?)?;
    if actual != expected {
        return Err(format!(
            "SOURCE_VERSION_CHANGED: {} is {}, expected {}",
            path.display(),
            actual,
            expected
        ));
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let leaf = field
        .rsplit('.')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "VERSION_FIELD_INVALID: field cannot be empty".to_string())?;
    let key =
        serde_json::to_string(leaf).map_err(|error| format!("VERSION_FIELD_INVALID: {error}"))?;
    let mut candidates = Vec::new();
    for (index, _) in raw.match_indices(&key) {
        let after_key = index + key.len();
        let whitespace = raw[after_key..]
            .char_indices()
            .take_while(|(_, character)| character.is_whitespace())
            .map(|(offset, character)| offset + character.len_utf8())
            .last()
            .unwrap_or(0);
        let colon = after_key + whitespace;
        if raw[colon..].starts_with(':') {
            candidates.push(colon);
        }
    }
    if candidates.len() != 1 {
        return Err(format!(
            "VERSION_FIELD_AMBIGUOUS: {field} has {} matching JSON properties in {}",
            candidates.len(),
            path.display()
        ));
    }

    let mut cursor = candidates[0] + 1;
    while let Some(character) = raw[cursor..].chars().next() {
        if !character.is_whitespace() {
            break;
        }
        cursor += character.len_utf8();
    }
    if !raw[cursor..].starts_with('"') {
        return Err(format!(
            "VERSION_FIELD_INVALID: {field} is not a JSON string in {}",
            path.display()
        ));
    }
    let start = cursor;
    cursor += 1;
    let bytes = raw.as_bytes();
    let mut escaped = false;
    let mut end = None;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            end = Some(cursor + 1);
            break;
        }
        cursor += 1;
    }
    let end = end.ok_or_else(|| {
        format!(
            "VERSION_FIELD_INVALID: unterminated JSON string in {}",
            path.display()
        )
    })?;
    let encoded =
        serde_json::to_string(next).map_err(|error| format!("VERSION_FIELD_INVALID: {error}"))?;
    let mut updated = String::with_capacity(raw.len() + encoded.len());
    updated.push_str(&raw[..start]);
    updated.push_str(&encoded);
    updated.push_str(&raw[end..]);
    fs::write(path, updated)
        .map_err(|error| format!("VERSION_FILE_WRITE_FAILED: {}: {error}", path.display()))
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct ParsedSemver {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<String>,
}

fn normalize_semver(raw: &str) -> Result<String, String> {
    let version = raw.trim().trim_start_matches('v').to_string();
    if version.contains('+') {
        return Err(
            "VERSION_INVALID: build metadata (+...) is not supported for releases".to_string(),
        );
    }
    parse_semver(&version)?;
    Ok(version)
}

fn parse_semver(value: &str) -> Result<ParsedSemver, String> {
    let (core, prerelease) = value
        .split_once('-')
        .map(|(core, pre)| (core, Some(pre)))
        .unwrap_or((value, None));
    let parts = core.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(format!(
            "VERSION_INVALID: {value:?} must use major.minor.patch"
        ));
    }
    let parse_number = |part: &str| {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.chars().all(|character| character.is_ascii_digit())
        {
            return Err(format!(
                "VERSION_INVALID: invalid numeric segment in {value:?}"
            ));
        }
        part.parse::<u64>()
            .map_err(|_| format!("VERSION_INVALID: numeric segment is too large in {value:?}"))
    };
    let prerelease = match prerelease {
        Some(pre) if valid_prerelease(pre) => pre.split('.').map(ToString::to_string).collect(),
        Some(_) => return Err(format!("VERSION_INVALID: invalid prerelease in {value:?}")),
        None => Vec::new(),
    };
    Ok(ParsedSemver {
        major: parse_number(parts[0])?,
        minor: parse_number(parts[1])?,
        patch: parse_number(parts[2])?,
        prerelease,
    })
}

fn valid_prerelease(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
                && !(part.len() > 1
                    && part.chars().all(|character| character.is_ascii_digit())
                    && part.starts_with('0'))
        })
}

fn ensure_newer_version(new_version: &str, current_version: &str) -> Result<(), String> {
    if compare_semver(new_version, current_version)? != Ordering::Greater {
        return Err(format!(
            "VERSION_NOT_NEWER: {new_version} must be greater than current source version {current_version}"
        ));
    }
    Ok(())
}

fn compare_semver(left: &str, right: &str) -> Result<Ordering, String> {
    let left = parse_semver(left)?;
    let right = parse_semver(right)?;
    match (left.major, left.minor, left.patch).cmp(&(right.major, right.minor, right.patch)) {
        Ordering::Equal => compare_prerelease(&left.prerelease, &right.prerelease),
        other => Ok(other),
    }
}

fn compare_prerelease(left: &[String], right: &[String]) -> Result<Ordering, String> {
    if left.is_empty() && right.is_empty() {
        return Ok(Ordering::Equal);
    }
    if left.is_empty() {
        return Ok(Ordering::Greater);
    }
    if right.is_empty() {
        return Ok(Ordering::Less);
    }
    for index in 0..left.len().max(right.len()) {
        match (left.get(index), right.get(index)) {
            (Some(left), Some(right)) => {
                let ordering = match (left.parse::<u64>(), right.parse::<u64>()) {
                    (Ok(left_number), Ok(right_number)) => left_number.cmp(&right_number),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => left.cmp(right),
                };
                if ordering != Ordering::Equal {
                    return Ok(ordering);
                }
            }
            (Some(_), None) => return Ok(Ordering::Greater),
            (None, Some(_)) => return Ok(Ordering::Less),
            (None, None) => break,
        }
    }
    Ok(Ordering::Equal)
}

fn canonical_existing_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!(
            "PATH_NOT_FOUND: {label} is not a directory: {}",
            path.display()
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("PATH_CANONICALIZE_FAILED: {}: {error}", path.display()))
}

fn resolve_path(base: &Path, configured: &str) -> PathBuf {
    let path = PathBuf::from(configured);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn collect_matching_files(root: &Path, patterns: &[String]) -> Result<Vec<PathBuf>, String> {
    if !root.is_dir() {
        return Err(format!("OUTPUT_DIR_NOT_FOUND: {}", root.display()));
    }
    let mut files = Vec::new();
    walk_files(root, root, patterns, &mut files)?;
    files.sort();
    Ok(files)
}

fn walk_files(
    root: &Path,
    current: &Path,
    patterns: &[String],
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(current)
        .map_err(|error| format!("OUTPUT_DIR_READ_FAILED: {}: {error}", current.display()))?
    {
        let entry = entry.map_err(|error| format!("OUTPUT_ENTRY_READ_FAILED: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            walk_files(root, &path, patterns, files)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if patterns
            .iter()
            .any(|pattern| wildcard_match(pattern, &relative) || wildcard_match(pattern, name))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase();
    let value = value.to_ascii_lowercase();
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut p, mut v, mut star, mut checkpoint) = (0usize, 0usize, None, 0usize);

    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            checkpoint = v;
            p += 1;
        } else if let Some(star_index) = star {
            p = star_index + 1;
            checkpoint += 1;
            v = checkpoint;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn is_manifest(path: &Path, patterns: &[String]) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    patterns.iter().any(|pattern| wildcard_match(pattern, name))
}

fn order_uploads(files: &[PathBuf], manifest_patterns: &[String]) -> Vec<(PathBuf, bool)> {
    let mut ordinary = files
        .iter()
        .filter(|path| !is_manifest(path, manifest_patterns))
        .cloned()
        .map(|path| (path, false))
        .collect::<Vec<_>>();
    ordinary.sort_by(|left, right| left.0.cmp(&right.0));
    let mut manifests = files
        .iter()
        .filter(|path| is_manifest(path, manifest_patterns))
        .cloned()
        .map(|path| (path, true))
        .collect::<Vec<_>>();
    manifests.sort_by(|left, right| left.0.cmp(&right.0));
    ordinary.extend(manifests);
    ordinary
}

fn upload_stage_lines(
    ordered: &[(PathBuf, bool)],
    uploader_output: &str,
    success: bool,
) -> Vec<String> {
    let mut lines = Vec::new();
    for (path, manifest) in ordered {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact");
        let uploaded = uploader_output.contains(&format!("[r2] uploaded {name} ->"));
        if uploaded || success {
            lines.push(stage_ok(upload_stage(*manifest), name));
        } else {
            lines.push(stage_fail(upload_stage(*manifest), name));
            break;
        }
    }
    lines
}

fn upload_stage(manifest: bool) -> &'static str {
    if manifest {
        "UPLOAD_MANIFEST"
    } else {
        "UPLOAD_ARTIFACT"
    }
}

fn destination_for(profile: &ExternalReleaseProfile) -> String {
    if profile.r2_prefix.trim().is_empty() {
        format!("r2://{}", profile.r2_bucket)
    } else {
        format!(
            "r2://{}/{}",
            profile.r2_bucket,
            profile.r2_prefix.trim_matches('/')
        )
    }
}

fn node_compatible_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(raw) = path.to_str() {
            if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{rest}"));
            }
            if let Some(rest) = raw.strip_prefix(r"\\?\") {
                return PathBuf::from(rest);
            }
        }
    }

    path.to_path_buf()
}

fn resource_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("resources").join(name);
        if packaged.is_file() {
            return Ok(packaged);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(name);
    if development.is_file() {
        return Ok(development);
    }
    Err(format!("RESOURCE_NOT_FOUND: {name}"))
}

fn run_shell(command: &str, cwd: &Path, version: &str, notes: &str) -> Result<Output, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut process = Command::new("cmd.exe");
        process.creation_flags(0x08000000);
        process.args(["/D", "/S", "/C", command]);
        process
            .env(RELEASE_VERSION_ENV, version)
            .env(RELEASE_NOTES_ENV, notes)
            .current_dir(cwd)
            .output()
            .map_err(|error| format!("BUILD_START_FAILED: {error}"))
    }

    #[cfg(not(windows))]
    {
        Command::new("sh")
            .args(["-lc", command])
            .env(RELEASE_VERSION_ENV, version)
            .env(RELEASE_NOTES_ENV, notes)
            .current_dir(cwd)
            .output()
            .map_err(|error| format!("BUILD_START_FAILED: {error}"))
    }
}

fn exit_code(output: &Output) -> String {
    output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal".to_string())
}

fn combined_output(output: &Output) -> String {
    const LIMIT: usize = 32_000;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout.trim(), stderr.trim())
        .trim()
        .to_string();
    let count = combined.chars().count();
    if count <= LIMIT {
        combined
    } else {
        let tail: String = combined.chars().skip(count - LIMIT).collect();
        format!("…{tail}")
    }
}

fn file_name_string(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| format!("FILE_NAME_INVALID: {}", path.display()))
}

fn stage_ok(stage: &str, detail: &str) -> String {
    format!("{stage} ✅ {detail}")
}

fn stage_fail(stage: &str, detail: &str) -> String {
    format!("{stage} ❌ {detail}")
}

fn push_output(log: &mut Vec<String>, output: &str) {
    if !output.trim().is_empty() {
        log.push(output.trim().to_string());
    }
}

fn with_rollback(
    mut log: Vec<String>,
    stage: &str,
    error: String,
    backup: &SourceBackup,
) -> String {
    log.push(stage_fail(stage, &error));
    rollback_log(log, backup)
}

fn rollback_log(mut log: Vec<String>, backup: &SourceBackup) -> String {
    match backup.restore() {
        Ok(()) => log.push("SOURCE_ROLLBACK ✅ restored release version metadata".to_string()),
        Err(error) => log.push(format!("SOURCE_ROLLBACK ❌ {error}")),
    }
    log.join("\n")
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_newer_version, node_compatible_path, order_uploads, prepare_json_manifest,
        prepare_manifest, replace_json_string_field, select_release_artifacts, stage_fail,
        sync_flutter_pubspec, upload_stage_lines, SourceBackup,
    };
    use serde_json::Value;
    use std::{fs, path::PathBuf, time::SystemTime};

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "key-manager-external-release-{label}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(windows)]
    #[test]
    fn node_paths_strip_windows_verbatim_prefixes() {
        assert_eq!(
            node_compatible_path(std::path::Path::new(
                r"\\?\F:\1_A_Disk_D\Tool\Hair_Spa_Manager"
            )),
            PathBuf::from(r"F:\1_A_Disk_D\Tool\Hair_Spa_Manager")
        );
        assert_eq!(
            node_compatible_path(std::path::Path::new(r"\\?\UNC\server\share\release")),
            PathBuf::from(r"\\server\share\release")
        );
    }

    #[test]
    fn external_release_requires_strict_newer_semver() {
        assert!(ensure_newer_version("1.8.1", "1.8.0").is_ok());
        assert!(ensure_newer_version("1.8.0", "1.8.0").is_err());
        assert!(ensure_newer_version("1.7.9", "1.8.0").is_err());
        assert!(ensure_newer_version("1.8", "1.8.0").is_err());
        assert!(ensure_newer_version("01.8.1", "1.8.0").is_err());
    }

    #[test]
    fn json_version_bump_changes_only_configured_string() {
        let dir = temp_dir("json-version");
        let path = dir.join("package.json");
        fs::write(
            &path,
            "{\n  \"name\": \"salon\",\n  \"version\": \"1.8.0\",\n  \"private\": true\n}\n",
        )
        .unwrap();
        replace_json_string_field(&path, "version", "1.8.0", "1.8.1").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"name\": \"salon\",\n  \"version\": \"1.8.1\",\n  \"private\": true\n}\n"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn flutter_pubspec_mirror_preserves_build_number() {
        let dir = temp_dir("pubspec");
        let path = dir.join("pubspec.yaml");
        fs::write(
            &path,
            "name: salon\nversion: 1.8.0+18\nenvironment:\n  sdk: ^3.11.5\n",
        )
        .unwrap();
        sync_flutter_pubspec(&path, "1.8.0", "1.8.1").unwrap();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("version: 1.8.1+18"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn json_manifest_gets_release_notes_and_keeps_target_version() {
        let dir = temp_dir("manifest");
        let path = dir.join("latest.json");
        fs::write(
            &path,
            r#"{"latestVersion":"1.8.1","message":"old","notes":[],"downloadPath":"Salon-Setup-1.8.1.exe"}"#,
        )
        .unwrap();
        prepare_json_manifest(&path, "1.8.1", "Sửa lỗi đồng bộ lịch hẹn").unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["latestVersion"], "1.8.1");
        assert_eq!(value["message"], "Sửa lỗi đồng bộ lịch hẹn");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn json_manifest_rejects_wrong_release_version() {
        let dir = temp_dir("manifest-mismatch");
        let path = dir.join("latest.json");
        fs::write(
            &path,
            r#"{"latestVersion":"1.8.0","downloadPath":"Salon-Setup-1.8.0.exe"}"#,
        )
        .unwrap();
        let error = prepare_json_manifest(&path, "1.8.1", "notes").unwrap_err();
        assert!(error.contains("MANIFEST_VERSION_MISMATCH"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn yaml_manifest_rejects_wrong_electron_builder_version() {
        let dir = temp_dir("yaml-manifest-mismatch");
        let path = dir.join("latest.yml");
        fs::write(
            &path,
            "version: 1.0.8\nfiles:\n  - url: PageAuto-Setup-1.0.8.exe\npath: PageAuto-Setup-1.0.8.exe\n",
        )
        .unwrap();
        let error = prepare_manifest(&path, "1.0.9", "notes").unwrap_err();
        assert!(error.contains("MANIFEST_VERSION_MISMATCH"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn artifact_selection_rejects_stale_versioned_builds() {
        let files = vec![
            PathBuf::from("PageAuto-Setup-1.0.8.exe"),
            PathBuf::from("PageAuto-Setup-1.0.8.exe.blockmap"),
            PathBuf::from("PageAuto.exe"),
            PathBuf::from("elevate.exe"),
        ];
        let error = select_release_artifacts(files, "1.0.9").unwrap_err();
        assert!(error.contains("ARTIFACT_VERSION_MISMATCH"));
        assert!(error.contains("PageAuto-Setup-1.0.8.exe"));
    }

    #[test]
    fn artifact_selection_keeps_target_version_and_unversioned_support_files() {
        let files = vec![
            PathBuf::from("PageAuto-Setup-1.0.8.exe"),
            PathBuf::from("PageAuto-Setup-1.0.9.exe"),
            PathBuf::from("PageAuto-Setup-1.0.9.exe.blockmap"),
            PathBuf::from("PageAuto.exe"),
            PathBuf::from("elevate.exe"),
        ];
        let selected = select_release_artifacts(files, "1.0.9").unwrap();
        assert!(selected.contains(&PathBuf::from("PageAuto-Setup-1.0.9.exe")));
        assert!(selected.contains(&PathBuf::from("PageAuto-Setup-1.0.9.exe.blockmap")));
        assert!(selected.contains(&PathBuf::from("PageAuto.exe")));
        assert!(selected.contains(&PathBuf::from("elevate.exe")));
        assert!(!selected.contains(&PathBuf::from("PageAuto-Setup-1.0.8.exe")));
    }

    #[test]
    fn publish_pointer_is_ordered_after_artifacts() {
        let files = vec![
            PathBuf::from("latest.json"),
            PathBuf::from("Salon-Setup-1.8.1.exe"),
        ];
        let ordered = order_uploads(&files, &["latest.json".to_string()]);
        assert_eq!(ordered[0].0, PathBuf::from("Salon-Setup-1.8.1.exe"));
        assert!(!ordered[0].1);
        assert_eq!(ordered[1].0, PathBuf::from("latest.json"));
        assert!(ordered[1].1);
    }

    #[test]
    fn r2_failure_log_marks_the_first_unuploaded_stage() {
        let ordered = vec![
            (PathBuf::from("Salon-Setup-1.8.1.exe"), false),
            (PathBuf::from("latest.json"), true),
        ];
        let lines = upload_stage_lines(
            &ordered,
            "[r2] uploaded Salon-Setup-1.8.1.exe -> r2://beauty-salon/Salon-Setup-1.8.1.exe\nR2_UPLOAD_HTTP_403: latest.json",
            false,
        );
        assert_eq!(lines[0], "UPLOAD_ARTIFACT ✅ Salon-Setup-1.8.1.exe");
        assert_eq!(lines[1], "UPLOAD_MANIFEST ❌ latest.json");
    }

    #[test]
    fn failed_release_restores_version_metadata_and_keeps_failure_log() {
        let dir = temp_dir("rollback");
        let path = dir.join("package.json");
        fs::write(&path, "{\"version\":\"1.8.0\"}\n").unwrap();
        let backup = SourceBackup::capture(std::slice::from_ref(&path)).unwrap();
        replace_json_string_field(&path, "version", "1.8.0", "1.8.1").unwrap();
        let mut log = vec![stage_fail("BUILD", "SALON exited with 1")];
        log.push("simulated build stderr".to_string());
        let message = super::rollback_log(log, &backup);
        assert!(message.contains("BUILD ❌ SALON exited with 1"));
        assert!(message.contains("simulated build stderr"));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"version\":\"1.8.0\"}\n"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
