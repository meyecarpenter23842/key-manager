use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "release-manager.json";
const R2_ACCOUNT_ENV: &str = "R2_ACCOUNT_ID";
const R2_ACCESS_ENV: &str = "R2_ACCESS_KEY_ID";
const R2_SECRET_ENV: &str = "R2_SECRET_ACCESS_KEY";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReleaseProfile {
    pub application_id: String,
    pub app_code: String,
    pub source_dir: String,
    pub build_command: String,
    pub output_dir: String,
    pub version_file: String,
    pub version_field: String,
    pub artifact_patterns: Vec<String>,
    pub manifest_patterns: Vec<String>,
    pub r2_bucket: String,
    pub r2_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManagerConfig {
    pub key_manager_source_dir: String,
    pub key_manager_build_command: String,
    pub key_manager_output_dir: String,
    pub key_manager_update_dir: String,
    pub external_profiles: Vec<ExternalReleaseProfile>,
}

impl Default for ReleaseManagerConfig {
    fn default() -> Self {
        Self {
            key_manager_source_dir: r"F:\1_A_Disk_D\key-manager".to_string(),
            key_manager_build_command: "pnpm tauri build --bundles nsis".to_string(),
            key_manager_output_dir: r"src-tauri\target\release\bundle\nsis".to_string(),
            key_manager_update_dir: r"F:\key-manager\update".to_string(),
            external_profiles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArtifact {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageResult {
    pub app_code: String,
    pub version: String,
    pub destination: String,
    pub artifacts: Vec<ReleaseArtifact>,
    pub log: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfUpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub available: bool,
    pub installer_name: Option<String>,
    pub installer_size: Option<u64>,
    pub update_dir: String,
}

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
    installer: String,
    artifacts: Vec<LocalManifestArtifact>,
}

#[tauri::command]
pub(crate) fn get_release_manager_config(app: AppHandle) -> Result<ReleaseManagerConfig, String> {
    load_config(&app)
}

#[tauri::command]
pub(crate) fn save_release_manager_config(
    app: AppHandle,
    config: ReleaseManagerConfig,
) -> Result<ReleaseManagerConfig, String> {
    validate_config(&config)?;
    persist_config(&app, &config)?;
    Ok(config)
}

#[tauri::command]
pub(crate) fn package_key_manager(app: AppHandle) -> Result<PackageResult, String> {
    let config = load_config(&app)?;
    validate_config(&config)?;

    let source = canonical_existing_dir(
        Path::new(&config.key_manager_source_dir),
        "Key Manager source",
    )?;
    let output_dir = resolve_path(&source, &config.key_manager_output_dir);
    let build = run_shell(&config.key_manager_build_command, &source)?;
    if !build.status.success() {
        return Err(format!(
            "BUILD_FAILED: Key Manager build exited with {}.\n{}",
            exit_code(&build),
            combined_output(&build)
        ));
    }

    let version = read_json_string(&source.join("src-tauri").join("tauri.conf.json"), "version")?;
    validate_version_segment(&version)?;

    let source_artifacts = collect_matching_files(&output_dir, &["*.exe".to_string()])?;
    if source_artifacts.is_empty() {
        return Err(format!(
            "ARTIFACT_NOT_FOUND: no NSIS .exe found under {}",
            output_dir.display()
        ));
    }

    let update_root = PathBuf::from(&config.key_manager_update_dir);
    fs::create_dir_all(&update_root)
        .map_err(|error| format!("UPDATE_DIR_CREATE_FAILED: {error}"))?;
    let version_dir = update_root.join(&version);
    fs::create_dir_all(&version_dir)
        .map_err(|error| format!("UPDATE_VERSION_DIR_CREATE_FAILED: {error}"))?;

    let mut copied = Vec::new();
    let mut manifest_artifacts = Vec::new();
    for artifact in source_artifacts {
        let name = file_name_string(&artifact)?;
        let destination = version_dir.join(&name);
        fs::copy(&artifact, &destination)
            .map_err(|error| format!("ARTIFACT_COPY_FAILED: {}: {error}", artifact.display()))?;
        let metadata = fs::metadata(&destination)
            .map_err(|error| format!("ARTIFACT_METADATA_FAILED: {error}"))?;
        let sha256 = sha256_file(&destination)?;
        copied.push(ReleaseArtifact {
            name: name.clone(),
            path: destination.display().to_string(),
            size: metadata.len(),
        });
        manifest_artifacts.push(LocalManifestArtifact {
            name,
            size: metadata.len(),
            sha256,
        });
    }

    let installer = manifest_artifacts
        .iter()
        .find(|item| item.name.to_ascii_lowercase().ends_with(".exe"))
        .map(|item| item.name.clone())
        .ok_or_else(|| "INSTALLER_NOT_FOUND: packaged release has no .exe installer".to_string())?;

    let manifest = LocalUpdateManifest {
        schema_version: 1,
        version: version.clone(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("CLOCK_ERROR: {error}"))?
            .as_secs(),
        installer,
        artifacts: manifest_artifacts,
    };
    write_json_atomic(&update_root.join("latest.json"), &manifest)?;

    Ok(PackageResult {
        app_code: "KEY_MANAGER".to_string(),
        version,
        destination: version_dir.display().to_string(),
        artifacts: copied,
        log: combined_output(&build),
    })
}

#[tauri::command]
pub(crate) fn check_key_manager_update(app: AppHandle) -> Result<SelfUpdateStatus, String> {
    let config = load_config(&app)?;
    let current = app.package_info().version.to_string();
    let update_root = PathBuf::from(&config.key_manager_update_dir);
    let manifest_path = update_root.join("latest.json");

    if !manifest_path.is_file() {
        return Ok(SelfUpdateStatus {
            current_version: current,
            latest_version: None,
            available: false,
            installer_name: None,
            installer_size: None,
            update_dir: update_root.display().to_string(),
        });
    }

    let manifest = read_local_manifest(&manifest_path)?;
    let installer = resolve_manifest_installer(&update_root, &manifest)?;
    let metadata = fs::metadata(&installer)
        .map_err(|error| format!("UPDATE_INSTALLER_METADATA_FAILED: {error}"))?;

    Ok(SelfUpdateStatus {
        available: compare_versions(&manifest.version, &current)? == Ordering::Greater,
        current_version: current,
        latest_version: Some(manifest.version),
        installer_name: Some(
            installer
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
        ),
        installer_size: Some(metadata.len()),
        update_dir: update_root.display().to_string(),
    })
}

#[tauri::command]
pub(crate) fn install_key_manager_update(app: AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(
            "SELF_UPDATE_UNSUPPORTED_IN_DEV: build/install a release build before testing self-update"
                .to_string(),
        );
    }

    let config = load_config(&app)?;
    let update_root = PathBuf::from(&config.key_manager_update_dir);
    let manifest = read_local_manifest(&update_root.join("latest.json"))?;
    let current = app.package_info().version.to_string();
    if compare_versions(&manifest.version, &current)? != Ordering::Greater {
        return Err(
            "NO_NEWER_VERSION: latest local release is not newer than the running app".to_string(),
        );
    }

    let installer = resolve_manifest_installer(&update_root, &manifest)?;
    let expected = manifest
        .artifacts
        .iter()
        .find(|item| item.name == manifest.installer)
        .ok_or_else(|| "MANIFEST_INVALID: installer is missing from artifacts".to_string())?;
    let actual = sha256_file(&installer)?;
    if !actual.eq_ignore_ascii_case(&expected.sha256) {
        return Err(format!(
            "UPDATE_HASH_MISMATCH: expected {}, got {}",
            expected.sha256, actual
        ));
    }

    let updater_script = resource_file(&app, "self-update.ps1")?;
    let current_exe =
        std::env::current_exe().map_err(|error| format!("CURRENT_EXE_FAILED: {error}"))?;

    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command.arg(updater_script);
    command.arg("-Installer").arg(&installer);
    command.arg("-Executable").arg(&current_exe);
    command
        .spawn()
        .map_err(|error| format!("SELF_UPDATE_LAUNCH_FAILED: {error}"))?;

    app.exit(0);
    Ok(())
}

#[tauri::command]
pub(crate) fn package_external_application(
    app: AppHandle,
    application_id: String,
) -> Result<PackageResult, String> {
    let config = load_config(&app)?;
    let profile = config
        .external_profiles
        .iter()
        .find(|profile| profile.application_id == application_id)
        .cloned()
        .ok_or_else(|| "RELEASE_PROFILE_NOT_FOUND: configure this application first".to_string())?;
    validate_external_profile(&profile)?;

    let source = canonical_existing_dir(Path::new(&profile.source_dir), "application source")?;
    let output_dir = resolve_path(&source, &profile.output_dir);
    let build = run_shell(&profile.build_command, &source)?;
    if !build.status.success() {
        return Err(format!(
            "BUILD_FAILED: {} exited with {}.\n{}",
            profile.app_code,
            exit_code(&build),
            combined_output(&build)
        ));
    }

    let version_file = resolve_path(&source, &profile.version_file);
    let version = read_json_string(&version_file, &profile.version_field)?;
    validate_version_segment(&version)?;

    let artifacts = collect_matching_files(&output_dir, &profile.artifact_patterns)?;
    if artifacts.is_empty() {
        return Err(format!(
            "ARTIFACT_NOT_FOUND: patterns {:?} matched nothing under {}",
            profile.artifact_patterns,
            output_dir.display()
        ));
    }
    if !profile.manifest_patterns.is_empty()
        && !artifacts.iter().any(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|name| matches_any(&profile.manifest_patterns, name))
                .unwrap_or(false)
        })
    {
        return Err(
            "PUBLISH_POINTER_NOT_FOUND: none of manifestPatterns matched a build artifact"
                .to_string(),
        );
    }

    let uploader = resource_file(&app, "r2-upload.mjs")?;
    for required in [R2_ACCOUNT_ENV, R2_ACCESS_ENV, R2_SECRET_ENV] {
        if std::env::var_os(required).is_none() {
            return Err(format!(
                "R2_CREDENTIAL_MISSING: environment variable {required} is not set"
            ));
        }
    }

    let mut command = Command::new("node");
    command.arg(uploader);
    command.arg("--bucket").arg(&profile.r2_bucket);
    command.arg("--prefix").arg(&profile.r2_prefix);
    for pattern in &profile.manifest_patterns {
        command.arg("--manifest").arg(pattern);
    }
    for artifact in &artifacts {
        command.arg("--file").arg(artifact);
    }
    let upload = command
        .current_dir(&source)
        .output()
        .map_err(|error| format!("R2_UPLOADER_START_FAILED: {error}"))?;
    if !upload.status.success() {
        return Err(format!(
            "R2_UPLOAD_FAILED: uploader exited with {}.\n{}",
            exit_code(&upload),
            combined_output(&upload)
        ));
    }

    let release_artifacts = artifacts
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
        .collect::<Result<Vec<_>, String>>()?;

    let destination = if profile.r2_prefix.trim().is_empty() {
        format!("r2://{}", profile.r2_bucket)
    } else {
        format!(
            "r2://{}/{}",
            profile.r2_bucket,
            profile.r2_prefix.trim_matches('/')
        )
    };

    Ok(PackageResult {
        app_code: profile.app_code,
        version,
        destination,
        artifacts: release_artifacts,
        log: format!("{}\n{}", combined_output(&build), combined_output(&upload)),
    })
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("CONFIG_DIR_FAILED: {error}"))?;
    Ok(dir.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> Result<ReleaseManagerConfig, String> {
    let path = config_path(app)?;
    if !path.is_file() {
        return Ok(ReleaseManagerConfig::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("CONFIG_READ_FAILED: {}: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("CONFIG_PARSE_FAILED: {error}"))
}

fn persist_config(app: &AppHandle, config: &ReleaseManagerConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("CONFIG_DIR_CREATE_FAILED: {error}"))?;
    }
    write_json_atomic(&path, config)
}

fn validate_config(config: &ReleaseManagerConfig) -> Result<(), String> {
    if config.key_manager_source_dir.trim().is_empty()
        || config.key_manager_build_command.trim().is_empty()
        || config.key_manager_output_dir.trim().is_empty()
        || config.key_manager_update_dir.trim().is_empty()
    {
        return Err(
            "RELEASE_CONFIG_INVALID: Key Manager paths/build command are required".to_string(),
        );
    }
    for profile in &config.external_profiles {
        validate_external_profile(profile)?;
    }
    Ok(())
}

fn validate_external_profile(profile: &ExternalReleaseProfile) -> Result<(), String> {
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
        .any(|segment| segment == ".." || segment == ".")
    {
        return Err(
            "RELEASE_PROFILE_INVALID: R2 prefix cannot contain . or .. segments".to_string(),
        );
    }
    Ok(())
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

fn read_json_string(path: &Path, field: &str) -> Result<String, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("VERSION_FILE_READ_FAILED: {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("VERSION_FILE_PARSE_FAILED: {error}"))?;
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

fn matches_any(patterns: &[String], value: &str) -> bool {
    patterns
        .iter()
        .any(|pattern| wildcard_match(pattern, value))
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

fn validate_version_segment(version: &str) -> Result<(), String> {
    if version.is_empty()
        || version == "."
        || version == ".."
        || !version
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-+_".contains(character))
    {
        return Err(format!("VERSION_INVALID: unsafe version value {version:?}"));
    }
    Ok(())
}

fn compare_versions(left: &str, right: &str) -> Result<Ordering, String> {
    fn parse(value: &str) -> Result<(Vec<u64>, Option<String>), String> {
        let value = value.trim_start_matches('v');
        let (core, pre) = value
            .split_once('-')
            .map(|(core, pre)| (core, Some(pre.to_string())))
            .unwrap_or((value, None));
        let numbers = core
            .split('.')
            .map(|part| {
                part.parse::<u64>().map_err(|_| {
                    format!("VERSION_INVALID: {value} is not a numeric dotted version")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if numbers.is_empty() {
            return Err(format!("VERSION_INVALID: {value}"));
        }
        Ok((numbers, pre))
    }

    let (mut left_numbers, left_pre) = parse(left)?;
    let (mut right_numbers, right_pre) = parse(right)?;
    let width = left_numbers.len().max(right_numbers.len());
    left_numbers.resize(width, 0);
    right_numbers.resize(width, 0);

    match left_numbers.cmp(&right_numbers) {
        Ordering::Equal => match (&left_pre, &right_pre) {
            (None, None) => Ok(Ordering::Equal),
            (None, Some(_)) => Ok(Ordering::Greater),
            (Some(_), None) => Ok(Ordering::Less),
            (Some(left), Some(right)) => Ok(left.cmp(right)),
        },
        other => Ok(other),
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("JSON_SERIALIZE_FAILED: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, raw)
        .map_err(|error| format!("FILE_WRITE_FAILED: {}: {error}", temporary.display()))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("FILE_REPLACE_FAILED: {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("FILE_RENAME_FAILED: {}: {error}", path.display()))
}

fn read_local_manifest(path: &Path) -> Result<LocalUpdateManifest, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("UPDATE_MANIFEST_READ_FAILED: {}: {error}", path.display()))?;
    let manifest: LocalUpdateManifest = serde_json::from_str(&raw)
        .map_err(|error| format!("UPDATE_MANIFEST_PARSE_FAILED: {error}"))?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "UPDATE_MANIFEST_UNSUPPORTED: schemaVersion {}",
            manifest.schema_version
        ));
    }
    validate_version_segment(&manifest.version)?;
    if manifest.installer.is_empty()
        || manifest.installer.contains('/')
        || manifest.installer.contains('\\')
        || manifest.installer == "."
        || manifest.installer == ".."
    {
        return Err("UPDATE_MANIFEST_INVALID: installer must be a file name".to_string());
    }
    Ok(manifest)
}

fn resolve_manifest_installer(
    update_root: &Path,
    manifest: &LocalUpdateManifest,
) -> Result<PathBuf, String> {
    let installer = update_root
        .join(&manifest.version)
        .join(&manifest.installer);
    if !installer.is_file() {
        return Err(format!(
            "UPDATE_INSTALLER_NOT_FOUND: {}",
            installer.display()
        ));
    }
    Ok(installer)
}

fn file_name_string(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| format!("FILE_NAME_INVALID: {}", path.display()))
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

fn run_shell(command: &str, cwd: &Path) -> Result<Output, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut process = Command::new("cmd.exe");
        process.creation_flags(0x08000000);
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
        let script =
            "$p=$env:KM_HASH_PATH; (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant()";
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

#[cfg(test)]
mod tests {
    use super::{compare_versions, validate_version_segment, wildcard_match};
    use std::cmp::Ordering;

    #[test]
    fn wildcard_patterns_match_release_artifacts() {
        assert!(wildcard_match("*.exe", "KeyManager_0.2.0_x64-setup.exe"));
        assert!(wildcard_match("**/*.blockmap", "dist/a.exe.blockmap"));
        assert!(wildcard_match("latest.ym?", "latest.yml"));
        assert!(!wildcard_match("latest.yml", "latest.json"));
    }

    #[test]
    fn version_order_handles_release_and_prerelease() {
        assert_eq!(
            compare_versions("0.2.0", "0.1.9").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.0.0", "1.0.0-beta.1").unwrap(),
            Ordering::Greater
        );
        assert_eq!(compare_versions("1.2", "1.2.0").unwrap(), Ordering::Equal);
    }

    #[test]
    fn version_segment_rejects_path_traversal() {
        assert!(validate_version_segment("1.2.3").is_ok());
        assert!(validate_version_segment("../1.2.3").is_err());
        assert!(validate_version_segment(r"1\2").is_err());
    }
}
