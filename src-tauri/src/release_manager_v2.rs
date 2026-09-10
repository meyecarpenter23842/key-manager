use crate::release_manager::{get_release_manager_config, PackageResult, ReleaseArtifact};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalManifestArtifact {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalUpdateManifest {
    schema_version: u32,
    version: String,
    created_at: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    release_notes: String,
    installer: String,
    artifacts: Vec<LocalManifestArtifact>,
}

struct SourceBackup {
    files: Vec<(PathBuf, Vec<u8>)>,
}

impl SourceBackup {
    fn capture(paths: &[PathBuf]) -> Result<Self, String> {
        let mut files = Vec::new();
        for path in paths {
            if path.is_file() {
                let content = fs::read(path)
                    .map_err(|error| format!("SOURCE_BACKUP_READ_FAILED: {}: {error}", path.display()))?;
                files.push((path.clone(), content));
            }
        }
        Ok(Self { files })
    }

    fn restore(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        for (path, content) in &self.files {
            if let Err(error) = fs::write(path, content) {
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
pub(crate) fn package_key_manager_release(
    app: AppHandle,
    new_version: String,
    release_notes: String,
) -> Result<PackageResult, String> {
    let config = get_release_manager_config(app)?;
    let source = canonical_existing_dir(
        Path::new(&config.key_manager_source_dir),
        "Key Manager source",
    )?;
    let update_root = PathBuf::from(&config.key_manager_update_dir);
    fs::create_dir_all(&update_root)
        .map_err(|error| format!("UPDATE_DIR_CREATE_FAILED: {error}"))?;

    let version = normalize_release_version(&new_version)?;
    let notes = release_notes.trim().to_string();
    if notes.is_empty() {
        return Err("RELEASE_NOTES_REQUIRED: release notes cannot be empty".to_string());
    }

    let tauri_config = source.join("src-tauri").join("tauri.conf.json");
    let cargo_toml = source.join("src-tauri").join("Cargo.toml");
    let package_json = source.join("package.json");
    let cargo_lock = source.join("src-tauri").join("Cargo.lock");

    let current_tauri = read_json_top_level_version(&tauri_config)?;
    let current_cargo = read_cargo_package_version(&cargo_toml)?;
    let current_package = read_json_top_level_version(&package_json)?;
    ensure_source_versions_match(&current_tauri, &current_cargo, &current_package)?;

    if compare_versions(&version, &current_tauri)? != Ordering::Greater {
        return Err(format!(
            "VERSION_NOT_NEWER: {version} must be greater than current source version {current_tauri}"
        ));
    }

    let version_dir = update_root.join(&version);
    if version_dir.exists() {
        return Err(format!(
            "RELEASE_ALREADY_EXISTS: {} already exists; choose a new version",
            version_dir.display()
        ));
    }

    let backup = SourceBackup::capture(&[
        tauri_config.clone(),
        cargo_toml.clone(),
        package_json.clone(),
        cargo_lock,
    ])?;

    let stage = update_root.join(format!(
        ".staging-{}-{}-{}",
        version,
        std::process::id(),
        unix_timestamp_millis()?
    ));
    if stage.exists() {
        fs::remove_dir_all(&stage)
            .map_err(|error| format!("RELEASE_STAGE_CLEAN_FAILED: {error}"))?;
    }

    let operation = (|| -> Result<PackageResult, String> {
        write_json_top_level_version(&tauri_config, &current_tauri, &version)?;
        write_cargo_package_version(&cargo_toml, &current_cargo, &version)?;
        write_json_top_level_version(&package_json, &current_package, &version)?;
        verify_synced_versions(&tauri_config, &cargo_toml, &package_json, &version)?;

        let output_dir = resolve_path(&source, &config.key_manager_output_dir);
        let build = run_shell(&config.key_manager_build_command, &source)?;
        if !build.status.success() {
            return Err(format!(
                "BUILD_FAILED: Key Manager build exited with {}.\n{}",
                exit_code(&build),
                combined_output(&build)
            ));
        }

        verify_synced_versions(&tauri_config, &cargo_toml, &package_json, &version)?;
        let source_artifacts = collect_version_installers(&output_dir, &version)?;
        if source_artifacts.is_empty() {
            return Err(format!(
                "ARTIFACT_NOT_FOUND: no NSIS .exe for version {version} found under {}",
                output_dir.display()
            ));
        }

        fs::create_dir_all(&stage)
            .map_err(|error| format!("RELEASE_STAGE_CREATE_FAILED: {error}"))?;

        let mut artifacts = Vec::new();
        let mut manifest_artifacts = Vec::new();
        for source_artifact in source_artifacts {
            let name = file_name_string(&source_artifact)?;
            let destination = stage.join(&name);
            fs::copy(&source_artifact, &destination).map_err(|error| {
                format!(
                    "ARTIFACT_COPY_FAILED: {} -> {}: {error}",
                    source_artifact.display(),
                    destination.display()
                )
            })?;
            let metadata = fs::metadata(&destination)
                .map_err(|error| format!("ARTIFACT_METADATA_FAILED: {error}"))?;
            let sha256 = sha256_file(&destination)?;
            artifacts.push(ReleaseArtifact {
                name: name.clone(),
                path: version_dir.join(&name).display().to_string(),
                size: metadata.len(),
            });
            manifest_artifacts.push(LocalManifestArtifact {
                name,
                size: metadata.len(),
                sha256,
            });
        }

        let installer = choose_installer(&manifest_artifacts, &version)?;
        let manifest = LocalUpdateManifest {
            schema_version: 1,
            version: version.clone(),
            created_at: unix_timestamp_secs()?,
            release_notes: notes.clone(),
            installer,
            artifacts: manifest_artifacts,
        };

        write_json_atomic(&stage.join("release.json"), &manifest)?;
        verify_staged_manifest(&stage, &manifest)?;

        fs::rename(&stage, &version_dir).map_err(|error| {
            format!(
                "RELEASE_PUBLISH_FAILED: {} -> {}: {error}",
                stage.display(),
                version_dir.display()
            )
        })?;
        verify_staged_manifest(&version_dir, &manifest)?;

        // Publish pointer is deliberately last. A failure here leaves a complete
        // version directory but keeps the previous latest.json intact.
        write_json_atomic(&update_root.join("latest.json"), &manifest)?;

        Ok(PackageResult {
            app_code: "KEY_MANAGER".to_string(),
            version: version.clone(),
            destination: version_dir.display().to_string(),
            artifacts,
            log: combined_output(&build),
        })
    })();

    match operation {
        Ok(result) => Ok(result),
        Err(error) => {
            if stage.exists() {
                let _ = fs::remove_dir_all(&stage);
            }
            let rollback = backup.restore();
            match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!("{error}\n{rollback_error}")),
            }
        }
    }
}

fn ensure_source_versions_match(tauri: &str, cargo: &str, package: &str) -> Result<(), String> {
    if tauri == cargo && tauri == package {
        return Ok(());
    }
    Err(format!(
        "SOURCE_VERSION_MISMATCH: tauri.conf.json={tauri}, Cargo.toml={cargo}, package.json={package}"
    ))
}

fn verify_synced_versions(
    tauri_config: &Path,
    cargo_toml: &Path,
    package_json: &Path,
    expected: &str,
) -> Result<(), String> {
    let tauri = read_json_top_level_version(tauri_config)?;
    let cargo = read_cargo_package_version(cargo_toml)?;
    let package = read_json_top_level_version(package_json)?;
    if tauri == expected && cargo == expected && package == expected {
        Ok(())
    } else {
        Err(format!(
            "SOURCE_VERSION_SYNC_FAILED: expected {expected}; tauri={tauri}, cargo={cargo}, package={package}"
        ))
    }
}

fn normalize_release_version(raw: &str) -> Result<String, String> {
    let version = raw.trim().trim_start_matches('v').to_string();
    parse_version(&version)?;
    if version.contains('+') {
        return Err(
            "VERSION_INVALID: build metadata (+...) is not supported for release folder versions"
                .to_string(),
        );
    }
    Ok(version)
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct ParsedVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<String>,
}

fn parse_version(value: &str) -> Result<ParsedVersion, String> {
    let (core_and_pre, build) = value
        .split_once('+')
        .map(|(left, right)| (left, Some(right)))
        .unwrap_or((value, None));
    if build.is_some_and(|part| !valid_identifiers(part)) {
        return Err(format!("VERSION_INVALID: invalid build metadata in {value:?}"));
    }
    let (core, prerelease) = core_and_pre
        .split_once('-')
        .map(|(left, right)| (left, Some(right)))
        .unwrap_or((core_and_pre, None));
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
            return Err(format!("VERSION_INVALID: invalid numeric segment in {value:?}"));
        }
        part.parse::<u64>()
            .map_err(|_| format!("VERSION_INVALID: numeric segment is too large in {value:?}"))
    };
    let prerelease = match prerelease {
        Some(part) if valid_identifiers(part) => part.split('.').map(ToString::to_string).collect(),
        Some(_) => return Err(format!("VERSION_INVALID: invalid prerelease in {value:?}")),
        None => Vec::new(),
    };
    Ok(ParsedVersion {
        major: parse_number(parts[0])?,
        minor: parse_number(parts[1])?,
        patch: parse_number(parts[2])?,
        prerelease,
    })
}

fn valid_identifiers(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
}

fn compare_versions(left: &str, right: &str) -> Result<Ordering, String> {
    let left = parse_version(left)?;
    let right = parse_version(right)?;
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
                let order = match (left.parse::<u64>(), right.parse::<u64>()) {
                    (Ok(left_number), Ok(right_number)) => left_number.cmp(&right_number),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => left.cmp(right),
                };
                if order != Ordering::Equal {
                    return Ok(order);
                }
            }
            (Some(_), None) => return Ok(Ordering::Greater),
            (None, Some(_)) => return Ok(Ordering::Less),
            (None, None) => break,
        }
    }
    Ok(Ordering::Equal)
}

fn read_json_top_level_version(path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("VERSION_FILE_PARSE_FAILED: {}: {error}", path.display()))?;
    value
        .get("version")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("VERSION_FIELD_INVALID: {} has no string version", path.display()))
}

fn write_json_top_level_version(path: &Path, old: &str, new: &str) -> Result<(), String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let marker = "\"version\"";
    let key_index = raw
        .find(marker)
        .ok_or_else(|| format!("VERSION_FIELD_NOT_FOUND: {}", path.display()))?;
    let after_key = key_index + marker.len();
    let colon_relative = raw[after_key..]
        .find(':')
        .ok_or_else(|| format!("VERSION_FIELD_INVALID: {}", path.display()))?;
    let colon = after_key + colon_relative;
    let quote_start_relative = raw[colon + 1..]
        .find('"')
        .ok_or_else(|| format!("VERSION_FIELD_INVALID: {}", path.display()))?;
    let quote_start = colon + 1 + quote_start_relative;
    let quote_end_relative = raw[quote_start + 1..]
        .find('"')
        .ok_or_else(|| format!("VERSION_FIELD_INVALID: {}", path.display()))?;
    let quote_end = quote_start + 1 + quote_end_relative;
    let actual = &raw[quote_start + 1..quote_end];
    if actual != old {
        return Err(format!(
            "SOURCE_VERSION_CHANGED: {} expected {old}, found {actual}",
            path.display()
        ));
    }
    let mut updated = String::with_capacity(raw.len() + new.len().saturating_sub(old.len()));
    updated.push_str(&raw[..quote_start + 1]);
    updated.push_str(new);
    updated.push_str(&raw[quote_end..]);
    fs::write(path, updated)
        .map_err(|error| format!("VERSION_FILE_WRITE_FAILED: {}: {error}", path.display()))
}

fn read_cargo_package_version(path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let mut in_package = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_package = trimmed == "[package]";
            continue;
        }
        if in_package && trimmed.starts_with("version") {
            let (_, value) = trimmed
                .split_once('=')
                .ok_or_else(|| format!("VERSION_FIELD_INVALID: {}", path.display()))?;
            let value = value.trim().trim_matches('"');
            if value.is_empty() {
                break;
            }
            return Ok(value.to_string());
        }
    }
    Err(format!(
        "VERSION_FIELD_NOT_FOUND: [package] version in {}",
        path.display()
    ))
}

fn write_cargo_package_version(path: &Path, old: &str, new: &str) -> Result<(), String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let mut in_package = false;
    let mut replaced = false;
    let mut output = String::with_capacity(raw.len() + new.len().saturating_sub(old.len()));
    for segment in raw.split_inclusive('\n') {
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let newline = if segment.ends_with('\n') { "\n" } else { "" };
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_package = trimmed == "[package]";
        }
        if in_package && !replaced && trimmed.starts_with("version") {
            let expected = format!("version = \"{old}\"");
            if trimmed != expected {
                return Err(format!(
                    "SOURCE_VERSION_CHANGED: {} expected {expected}, found {trimmed}",
                    path.display()
                ));
            }
            let indent_len = line.len() - line.trim_start().len();
            output.push_str(&line[..indent_len]);
            output.push_str(&format!("version = \"{new}\""));
            output.push_str(newline);
            replaced = true;
        } else {
            output.push_str(line);
            output.push_str(newline);
        }
    }
    if !replaced {
        return Err(format!(
            "VERSION_FIELD_NOT_FOUND: [package] version in {}",
            path.display()
        ));
    }
    fs::write(path, output)
        .map_err(|error| format!("VERSION_FILE_WRITE_FAILED: {}: {error}", path.display()))
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

fn collect_version_installers(root: &Path, version: &str) -> Result<Vec<PathBuf>, String> {
    if !root.is_dir() {
        return Err(format!("OUTPUT_DIR_NOT_FOUND: {}", root.display()));
    }
    let mut files = Vec::new();
    walk_installers(root, version, &mut files)?;
    files.sort();
    Ok(files)
}

fn walk_installers(current: &Path, version: &str, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(current)
        .map_err(|error| format!("OUTPUT_DIR_READ_FAILED: {}: {error}", current.display()))?
    {
        let entry = entry.map_err(|error| format!("OUTPUT_ENTRY_READ_FAILED: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            walk_installers(&path, version, files)?;
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if path.is_file()
            && name.to_ascii_lowercase().ends_with(".exe")
            && name.contains(version)
        {
            files.push(path);
        }
    }
    Ok(())
}

fn choose_installer(artifacts: &[LocalManifestArtifact], version: &str) -> Result<String, String> {
    let mut candidates = artifacts
        .iter()
        .filter(|item| item.name.to_ascii_lowercase().ends_with(".exe"))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.size.cmp(&left.size));
    candidates
        .first()
        .map(|item| item.name.clone())
        .ok_or_else(|| format!("INSTALLER_NOT_FOUND: no .exe installer for {version}"))
}

fn verify_staged_manifest(root: &Path, manifest: &LocalUpdateManifest) -> Result<(), String> {
    if manifest.artifacts.is_empty() {
        return Err("MANIFEST_INVALID: release has no artifacts".to_string());
    }
    if !manifest
        .artifacts
        .iter()
        .any(|artifact| artifact.name == manifest.installer)
    {
        return Err("MANIFEST_INVALID: installer is missing from artifacts".to_string());
    }
    for artifact in &manifest.artifacts {
        if artifact.name.contains('/') || artifact.name.contains('\\') {
            return Err(format!(
                "MANIFEST_INVALID: unsafe artifact name {}",
                artifact.name
            ));
        }
        let path = root.join(&artifact.name);
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("ARTIFACT_VERIFY_METADATA_FAILED: {}: {error}", path.display()))?;
        if metadata.len() != artifact.size {
            return Err(format!(
                "ARTIFACT_SIZE_MISMATCH: {} expected {}, got {}",
                artifact.name,
                artifact.size,
                metadata.len()
            ));
        }
        let actual = sha256_file(&path)?;
        if !actual.eq_ignore_ascii_case(&artifact.sha256) {
            return Err(format!(
                "ARTIFACT_HASH_MISMATCH: {} expected {}, got {}",
                artifact.name, artifact.sha256, actual
            ));
        }
    }
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("JSON_SERIALIZE_FAILED: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    fs::write(&temporary, raw)
        .map_err(|error| format!("FILE_WRITE_FAILED: {}: {error}", temporary.display()))?;

    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|error| format!("FILE_BACKUP_CLEAN_FAILED: {}: {error}", backup.display()))?;
    }
    let had_original = path.exists();
    if had_original {
        fs::rename(path, &backup)
            .map_err(|error| format!("FILE_BACKUP_FAILED: {}: {error}", path.display()))?;
    }
    match fs::rename(&temporary, path) {
        Ok(()) => {
            if had_original {
                let _ = fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(error) => {
            if had_original && backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(&temporary);
            Err(format!("FILE_RENAME_FAILED: {}: {error}", path.display()))
        }
    }
}

fn run_shell(command: &str, cwd: &Path) -> Result<Output, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut process = Command::new("cmd.exe");
        process.creation_flags(0x0800_0000);
        process.args(["/D", "/S", "/C", command]);
        process
            .current_dir(cwd)
            .output()
            .map_err(|error| format!("BUILD_START_FAILED: {error}"))
    }

    #[cfg(not(windows))]
    {
        Command::new("sh")
            .args(["-lc", command])
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

fn sha256_file(path: &Path) -> Result<String, String> {
    #[cfg(windows)]
    {
        let script = "$p=$env:KM_HASH_PATH; (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant()";
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("KM_HASH_PATH", path)
            .output()
            .map_err(|error| format!("HASH_COMMAND_FAILED: {error}"))?;
        if !output.status.success() {
            return Err(format!("HASH_COMMAND_FAILED: {}", combined_output(&output)));
        }
        let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if hash.len() != 64 || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err(format!("HASH_COMMAND_INVALID: {hash:?}"));
        }
        Ok(hash.to_ascii_lowercase())
    }

    #[cfg(not(windows))]
    {
        let output = Command::new("sha256sum")
            .arg(path)
            .output()
            .map_err(|error| format!("HASH_COMMAND_FAILED: {error}"))?;
        if !output.status.success() {
            return Err(format!("HASH_COMMAND_FAILED: {}", combined_output(&output)));
        }
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .next()
            .map(ToString::to_string)
            .ok_or_else(|| "HASH_COMMAND_INVALID: empty sha256sum output".to_string())
    }
}

fn file_name_string(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| format!("FILE_NAME_INVALID: {}", path.display()))
}

fn unix_timestamp_secs() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("CLOCK_ERROR: {error}"))
        .map(|duration| duration.as_secs())
}

fn unix_timestamp_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("CLOCK_ERROR: {error}"))
        .map(|duration| duration.as_millis())
}

#[cfg(test)]
mod tests {
    use super::{
        compare_versions, normalize_release_version, read_cargo_package_version,
        write_cargo_package_version,
    };
    use std::{cmp::Ordering, fs, time::SystemTime};

    #[test]
    fn release_version_requires_semver_and_newer_ordering() {
        assert_eq!(normalize_release_version(" v0.1.1 ").unwrap(), "0.1.1");
        assert!(normalize_release_version("0.1").is_err());
        assert!(normalize_release_version("0.1.1+local").is_err());
        assert_eq!(
            compare_versions("0.1.1", "0.1.0").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.0.0", "1.0.0-rc.1").unwrap(),
            Ordering::Greater
        );
    }

    #[test]
    fn cargo_package_version_updates_only_package_section() {
        let mut path = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("key-manager-cargo-{stamp}.toml"));
        fs::write(
            &path,
            "[package]\nname = \"key-manager\"\nversion = \"0.1.0\"\n\n[dependencies]\nthing = \"0.1.0\"\n",
        )
        .unwrap();
        write_cargo_package_version(&path, "0.1.0", "0.1.1").unwrap();
        assert_eq!(read_cargo_package_version(&path).unwrap(), "0.1.1");
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("thing = \"0.1.0\""));
        let _ = fs::remove_file(path);
    }
}
