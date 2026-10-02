use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const VAULT_FILE: &str = "android-signing.dat";
const VAULT_HEADER: &str = "KM-ANDROID-SIGNING-DPAPI-V1";
const VAULT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub(crate) struct AndroidSigningResolved {
    pub keystore_path: String,
    pub keystore_password: String,
    pub key_alias: String,
    pub key_password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidSigningProfileSummary {
    pub application_id: String,
    pub keystore_path: String,
    pub keystore_password: String,
    pub key_alias: String,
    pub key_password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidSigningState {
    pub profiles: Vec<AndroidSigningProfileSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAndroidSigningProfileInput {
    pub application_id: String,
    pub keystore_path: String,
    pub keystore_password: String,
    pub key_alias: String,
    pub key_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAndroidSigningProfile {
    application_id: String,
    keystore_path: String,
    keystore_password: String,
    key_alias: String,
    key_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidSigningVault {
    schema_version: u32,
    profiles: Vec<StoredAndroidSigningProfile>,
}

impl Default for AndroidSigningVault {
    fn default() -> Self {
        Self {
            schema_version: VAULT_SCHEMA_VERSION,
            profiles: Vec::new(),
        }
    }
}

#[tauri::command]
pub(crate) fn list_android_signing_profiles(
    app: AppHandle,
) -> Result<AndroidSigningState, String> {
    let vault = load_vault(&app)?;
    Ok(AndroidSigningState {
        profiles: vault.profiles.iter().map(to_summary).collect(),
    })
}

#[tauri::command]
pub(crate) fn save_android_signing_profile(
    app: AppHandle,
    input: SaveAndroidSigningProfileInput,
) -> Result<AndroidSigningProfileSummary, String> {
    let application_id = validate_field("applicationId", &input.application_id, 160)?;
    let keystore_path = validate_field("keystorePath", &input.keystore_path, 1024)?;
    let keystore_password = validate_field("keystorePassword", &input.keystore_password, 512)?;
    let key_alias = validate_field("keyAlias", &input.key_alias, 256)?;
    let key_password = validate_field("keyPassword", &input.key_password, 512)?;

    let profile = StoredAndroidSigningProfile {
        application_id: application_id.to_string(),
        keystore_path: keystore_path.to_string(),
        keystore_password: keystore_password.to_string(),
        key_alias: key_alias.to_string(),
        key_password: key_password.to_string(),
    };

    let mut vault = load_vault(&app)?;
    vault
        .profiles
        .retain(|item| item.application_id != profile.application_id);
    vault.profiles.push(profile.clone());
    vault
        .profiles
        .sort_by(|left, right| left.application_id.cmp(&right.application_id));
    persist_vault(&app, &vault)?;
    Ok(to_summary(&profile))
}

#[tauri::command]
pub(crate) fn delete_android_signing_profile(
    app: AppHandle,
    application_id: String,
) -> Result<(), String> {
    let application_id = validate_field("applicationId", &application_id, 160)?;
    let mut vault = load_vault(&app)?;
    let before = vault.profiles.len();
    vault
        .profiles
        .retain(|profile| profile.application_id != application_id);
    if vault.profiles.len() == before {
        return Ok(());
    }
    persist_vault(&app, &vault)
}

pub(crate) fn resolve_for_application(
    app: &AppHandle,
    application_id: &str,
) -> Result<Option<AndroidSigningResolved>, String> {
    let vault = load_vault(app)?;
    let Some(profile) = vault
        .profiles
        .iter()
        .find(|profile| profile.application_id == application_id)
    else {
        return Ok(None);
    };

    Ok(Some(AndroidSigningResolved {
        keystore_path: profile.keystore_path.clone(),
        keystore_password: profile.keystore_password.clone(),
        key_alias: profile.key_alias.clone(),
        key_password: profile.key_password.clone(),
    }))
}

pub(crate) fn env_prefix(app_code: &str) -> Result<String, String> {
    let mut prefix = String::new();
    let mut previous_was_separator = false;

    for character in app_code.trim().chars() {
        if character.is_ascii_alphanumeric() {
            prefix.push(character.to_ascii_uppercase());
            previous_was_separator = false;
        } else if !prefix.is_empty() && !previous_was_separator {
            prefix.push('_');
            previous_was_separator = true;
        }
    }

    while prefix.ends_with('_') {
        prefix.pop();
    }

    if prefix.is_empty()
        || prefix
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
    {
        return Err(format!(
            "ANDROID_SIGNING_APP_CODE_INVALID: {app_code:?} cannot be converted to an environment prefix"
        ));
    }
    Ok(prefix)
}

pub(crate) fn validate_keystore(credentials: &AndroidSigningResolved) -> Result<(), String> {
    let path = Path::new(&credentials.keystore_path);
    if !path.is_file() {
        return Err(format!(
            "ANDROID_SIGNING_KEYSTORE_NOT_FOUND: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_field<'a>(label: &str, value: &'a str, max: usize) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max
        || value
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return Err(format!("ANDROID_SIGNING_INVALID: {label} is invalid"));
    }
    Ok(value)
}

fn to_summary(profile: &StoredAndroidSigningProfile) -> AndroidSigningProfileSummary {
    AndroidSigningProfileSummary {
        application_id: profile.application_id.clone(),
        keystore_path: profile.keystore_path.clone(),
        keystore_password: profile.keystore_password.clone(),
        key_alias: profile.key_alias.clone(),
        key_password: profile.key_password.clone(),
    }
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("ANDROID_SIGNING_DIR_FAILED: {error}"))?;
    Ok(directory.join(VAULT_FILE))
}

fn load_vault(app: &AppHandle) -> Result<AndroidSigningVault, String> {
    let path = vault_path(app)?;
    if !path.is_file() {
        return Ok(AndroidSigningVault::default());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("ANDROID_SIGNING_READ_FAILED: {}: {error}", path.display()))?;
    let mut lines = raw.lines();
    if lines.next() != Some(VAULT_HEADER) {
        return Err("ANDROID_SIGNING_FORMAT_INVALID: unsupported vault header".to_string());
    }
    let encoded = lines.collect::<String>();
    if encoded.is_empty() {
        return Err("ANDROID_SIGNING_FORMAT_INVALID: encrypted payload is empty".to_string());
    }
    let encrypted = hex_decode(&encoded)?;
    let plaintext = dpapi_unprotect(&encrypted)?;
    let vault: AndroidSigningVault = serde_json::from_slice(&plaintext)
        .map_err(|error| format!("ANDROID_SIGNING_PARSE_FAILED: {error}"))?;
    if vault.schema_version != VAULT_SCHEMA_VERSION {
        return Err(format!(
            "ANDROID_SIGNING_SCHEMA_UNSUPPORTED: {}",
            vault.schema_version
        ));
    }
    Ok(vault)
}

fn persist_vault(app: &AppHandle, vault: &AndroidSigningVault) -> Result<(), String> {
    let plaintext = serde_json::to_vec(vault)
        .map_err(|error| format!("ANDROID_SIGNING_SERIALIZE_FAILED: {error}"))?;
    let encrypted = dpapi_protect(&plaintext)?;
    let contents = format!("{VAULT_HEADER}\n{}\n", hex_encode(&encrypted));
    write_atomic(&vault_path(app)?, contents.as_bytes())
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "ANDROID_SIGNING_PATH_INVALID".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("ANDROID_SIGNING_DIR_CREATE_FAILED: {error}"))?;

    let temporary = path.with_extension("dat.tmp");
    let backup = path.with_extension("dat.bak");
    fs::write(&temporary, contents)
        .map_err(|error| format!("ANDROID_SIGNING_WRITE_FAILED: {error}"))?;

    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    let had_original = path.exists();
    if had_original {
        fs::rename(path, &backup)
            .map_err(|error| format!("ANDROID_SIGNING_BACKUP_FAILED: {error}"))?;
    }

    if let Err(error) = fs::rename(&temporary, path) {
        if had_original {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("ANDROID_SIGNING_COMMIT_FAILED: {error}"));
    }

    if had_original {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    if bytes.len() % 2 != 0 {
        return Err("ANDROID_SIGNING_FORMAT_INVALID: encrypted payload is not valid hex".to_string());
    }

    let mut output = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let high = hex_nibble(chunk[0])?;
        let low = hex_nibble(chunk[1])?;
        output.push((high << 4) | low);
    }
    Ok(output)
}

fn hex_nibble(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("ANDROID_SIGNING_FORMAT_INVALID: encrypted payload is not valid hex".to_string()),
    }
}

#[cfg(windows)]
fn dpapi_protect(input: &[u8]) -> Result<Vec<u8>, String> {
    dpapi::protect(input)
}

#[cfg(not(windows))]
fn dpapi_protect(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("ANDROID_SIGNING_DPAPI_UNAVAILABLE: signing profiles require Windows".to_string())
}

#[cfg(windows)]
fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    dpapi::unprotect(input)
}

#[cfg(not(windows))]
fn dpapi_unprotect(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("ANDROID_SIGNING_DPAPI_UNAVAILABLE: signing profiles require Windows".to_string())
}

#[cfg(windows)]
mod dpapi {
    use std::{ffi::c_void, ptr, slice};

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            data_description: *const u16,
            optional_entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt_struct: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            data_in: *const DataBlob,
            data_description: *mut *mut u16,
            optional_entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt_struct: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub(super) fn protect(input: &[u8]) -> Result<Vec<u8>, String> {
        run_dpapi(input, true)
    }

    pub(super) fn unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
        run_dpapi(input, false)
    }

    fn run_dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input_len = u32::try_from(input.len())
            .map_err(|_| "ANDROID_SIGNING_DPAPI_FAILED: payload is too large".to_string())?;
        let input_blob = DataBlob {
            cb_data: input_len,
            pb_data: input.as_ptr() as *mut u8,
        };
        let mut output_blob = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };

        let success = unsafe {
            if protect {
                CryptProtectData(
                    &input_blob,
                    ptr::null(),
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output_blob,
                )
            } else {
                CryptUnprotectData(
                    &input_blob,
                    ptr::null_mut(),
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output_blob,
                )
            }
        };

        if success == 0 {
            return Err(format!(
                "ANDROID_SIGNING_DPAPI_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }
        if output_blob.pb_data.is_null() {
            return Err("ANDROID_SIGNING_DPAPI_FAILED: Windows returned an empty buffer".to_string());
        }

        let output = unsafe {
            slice::from_raw_parts(output_blob.pb_data, output_blob.cb_data as usize).to_vec()
        };
        unsafe {
            LocalFree(output_blob.pb_data.cast::<c_void>());
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::{env_prefix, hex_decode, hex_encode, to_summary, StoredAndroidSigningProfile};

    #[test]
    fn encrypted_payload_hex_round_trips() {
        let raw = b"\0android-signing\xff";
        let encoded = hex_encode(raw);
        assert_eq!(hex_decode(&encoded).unwrap(), raw);
    }

    #[test]
    fn owner_summary_contains_full_signing_values() {
        let stored = StoredAndroidSigningProfile {
            application_id: "app-1".to_string(),
            keystore_path: r"F:\signing\release.jks".to_string(),
            keystore_password: "store-secret".to_string(),
            key_alias: "release".to_string(),
            key_password: "key-secret".to_string(),
        };
        let summary = to_summary(&stored);
        assert_eq!(summary.keystore_password, "store-secret");
        assert_eq!(summary.key_password, "key-secret");
        assert_eq!(summary.keystore_path, r"F:\signing\release.jks");
    }

    #[test]
    fn app_code_is_canonicalized_to_stable_env_prefix() {
        assert_eq!(env_prefix("retail").unwrap(), "RETAIL");
        assert_eq!(env_prefix("mcp-app").unwrap(), "MCP_APP");
        assert_eq!(env_prefix("ordering app").unwrap(), "ORDERING_APP");
        assert!(env_prefix("123").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_uses_current_windows_user() {
        let raw = b"android-signing-profile-round-trip";
        let encrypted = super::dpapi_protect(raw).unwrap();
        assert_ne!(encrypted, raw);
        assert_eq!(super::dpapi_unprotect(&encrypted).unwrap(), raw);
    }
}
