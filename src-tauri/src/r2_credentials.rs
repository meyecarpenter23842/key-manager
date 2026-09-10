use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const VAULT_FILE: &str = "r2-credentials.dat";
const VAULT_HEADER: &str = "KM-R2-DPAPI-V1";
const VAULT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub(crate) struct R2ResolvedCredentials {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct R2CredentialProfileSummary {
    pub id: String,
    pub name: String,
    pub account_id: String,
    pub access_key_preview: String,
    pub has_secret: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct R2CredentialBindingSummary {
    pub application_id: String,
    pub credential_profile_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct R2CredentialState {
    pub profiles: Vec<R2CredentialProfileSummary>,
    pub bindings: Vec<R2CredentialBindingSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveR2CredentialProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredR2CredentialProfile {
    id: String,
    name: String,
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredR2CredentialBinding {
    application_id: String,
    credential_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct R2CredentialVault {
    schema_version: u32,
    profiles: Vec<StoredR2CredentialProfile>,
    bindings: Vec<StoredR2CredentialBinding>,
}

impl Default for R2CredentialVault {
    fn default() -> Self {
        Self {
            schema_version: VAULT_SCHEMA_VERSION,
            profiles: Vec::new(),
            bindings: Vec::new(),
        }
    }
}

#[tauri::command]
pub(crate) fn list_r2_credential_profiles(app: AppHandle) -> Result<R2CredentialState, String> {
    let vault = load_vault(&app)?;
    Ok(to_public_state(&vault))
}

#[tauri::command]
pub(crate) fn save_r2_credential_profile(
    app: AppHandle,
    input: SaveR2CredentialProfileInput,
) -> Result<R2CredentialProfileSummary, String> {
    let mut vault = load_vault(&app)?;
    let name = validate_non_secret_field("name", &input.name, 80)?;
    let account_id = validate_non_secret_field("accountId", &input.account_id, 160)?;
    let requested_id = input.id.as_deref().map(str::trim).filter(|value| !value.is_empty());

    let profile = if let Some(id) = requested_id {
        let existing = vault
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| format!("R2_CREDENTIAL_PROFILE_NOT_FOUND: {id}"))?;

        existing.name = name.to_string();
        existing.account_id = account_id.to_string();
        if !input.access_key_id.trim().is_empty() {
            existing.access_key_id = validate_secret_field("accessKeyId", &input.access_key_id)?;
        }
        if !input.secret_access_key.trim().is_empty() {
            existing.secret_access_key =
                validate_secret_field("secretAccessKey", &input.secret_access_key)?;
        }
        existing.clone()
    } else {
        let access_key_id = validate_secret_field("accessKeyId", &input.access_key_id)?;
        let secret_access_key = validate_secret_field("secretAccessKey", &input.secret_access_key)?;
        let id = generate_profile_id(&vault);
        let profile = StoredR2CredentialProfile {
            id,
            name: name.to_string(),
            account_id: account_id.to_string(),
            access_key_id,
            secret_access_key,
        };
        vault.profiles.push(profile.clone());
        profile
    };

    persist_vault(&app, &vault)?;
    Ok(to_summary(&profile))
}

#[tauri::command]
pub(crate) fn delete_r2_credential_profile(app: AppHandle, id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("R2_CREDENTIAL_PROFILE_ID_INVALID: id is required".to_string());
    }

    let mut vault = load_vault(&app)?;
    if let Some(binding) = vault
        .bindings
        .iter()
        .find(|binding| binding.credential_profile_id == id)
    {
        return Err(format!(
            "R2_CREDENTIAL_PROFILE_IN_USE: profile is assigned to application {}",
            binding.application_id
        ));
    }

    let before = vault.profiles.len();
    vault.profiles.retain(|profile| profile.id != id);
    if vault.profiles.len() == before {
        return Err(format!("R2_CREDENTIAL_PROFILE_NOT_FOUND: {id}"));
    }
    persist_vault(&app, &vault)
}

#[tauri::command]
pub(crate) fn bind_r2_credential_profile(
    app: AppHandle,
    application_id: String,
    credential_profile_id: Option<String>,
) -> Result<(), String> {
    let application_id =
        validate_non_secret_field("applicationId", &application_id, 160)?.to_string();
    let selected = credential_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let mut vault = load_vault(&app)?;
    if let Some(id) = selected.as_deref() {
        if !vault.profiles.iter().any(|profile| profile.id == id) {
            return Err(format!("R2_CREDENTIAL_PROFILE_NOT_FOUND: {id}"));
        }
    }

    vault
        .bindings
        .retain(|binding| binding.application_id != application_id);
    if let Some(credential_profile_id) = selected {
        vault.bindings.push(StoredR2CredentialBinding {
            application_id,
            credential_profile_id,
        });
    }
    persist_vault(&app, &vault)
}

pub(crate) fn resolve_for_application(
    app: &AppHandle,
    application_id: &str,
) -> Result<Option<R2ResolvedCredentials>, String> {
    let vault = load_vault(app)?;
    let Some(binding) = vault
        .bindings
        .iter()
        .find(|binding| binding.application_id == application_id)
    else {
        return Ok(None);
    };

    let profile = vault
        .profiles
        .iter()
        .find(|profile| profile.id == binding.credential_profile_id)
        .ok_or_else(|| {
            format!(
                "R2_CREDENTIAL_PROFILE_NOT_FOUND: binding for {application_id} references {}",
                binding.credential_profile_id
            )
        })?;

    Ok(Some(R2ResolvedCredentials {
        account_id: profile.account_id.clone(),
        access_key_id: profile.access_key_id.clone(),
        secret_access_key: profile.secret_access_key.clone(),
    }))
}

fn validate_non_secret_field<'a>(
    label: &str,
    value: &'a str,
    max: usize,
) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max
        || value
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return Err(format!("R2_CREDENTIAL_INVALID: {label} is invalid"));
    }
    Ok(value)
}

fn validate_secret_field(label: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 512
        || value
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return Err(format!("R2_CREDENTIAL_INVALID: {label} is invalid"));
    }
    Ok(value.to_string())
}

fn generate_profile_id(vault: &R2CredentialVault) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let base = format!("r2-{now:x}-{:x}", std::process::id());
    if !vault.profiles.iter().any(|profile| profile.id == base) {
        return base;
    }
    for suffix in 1u32.. {
        let candidate = format!("{base}-{suffix:x}");
        if !vault.profiles.iter().any(|profile| profile.id == candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn to_public_state(vault: &R2CredentialVault) -> R2CredentialState {
    R2CredentialState {
        profiles: vault.profiles.iter().map(to_summary).collect(),
        bindings: vault
            .bindings
            .iter()
            .map(|binding| R2CredentialBindingSummary {
                application_id: binding.application_id.clone(),
                credential_profile_id: binding.credential_profile_id.clone(),
            })
            .collect(),
    }
}

fn to_summary(profile: &StoredR2CredentialProfile) -> R2CredentialProfileSummary {
    R2CredentialProfileSummary {
        id: profile.id.clone(),
        name: profile.name.clone(),
        account_id: profile.account_id.clone(),
        access_key_preview: mask_access_key(&profile.access_key_id),
        has_secret: !profile.secret_access_key.is_empty(),
    }
}

fn mask_access_key(value: &str) -> String {
    let last: String = value.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    if last.is_empty() {
        "****".to_string()
    } else {
        format!("****{last}")
    }
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("R2_CREDENTIAL_DIR_FAILED: {error}"))?;
    Ok(directory.join(VAULT_FILE))
}

fn load_vault(app: &AppHandle) -> Result<R2CredentialVault, String> {
    let path = vault_path(app)?;
    if !path.is_file() {
        return Ok(R2CredentialVault::default());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("R2_CREDENTIAL_READ_FAILED: {}: {error}", path.display()))?;
    let mut lines = raw.lines();
    if lines.next() != Some(VAULT_HEADER) {
        return Err("R2_CREDENTIAL_FORMAT_INVALID: unsupported vault header".to_string());
    }
    let encoded = lines.collect::<String>();
    if encoded.is_empty() {
        return Err("R2_CREDENTIAL_FORMAT_INVALID: encrypted payload is empty".to_string());
    }
    let encrypted = hex_decode(&encoded)?;
    let plaintext = dpapi_unprotect(&encrypted)?;
    let vault: R2CredentialVault = serde_json::from_slice(&plaintext)
        .map_err(|error| format!("R2_CREDENTIAL_PARSE_FAILED: {error}"))?;
    if vault.schema_version != VAULT_SCHEMA_VERSION {
        return Err(format!(
            "R2_CREDENTIAL_SCHEMA_UNSUPPORTED: {}",
            vault.schema_version
        ));
    }
    Ok(vault)
}

fn persist_vault(app: &AppHandle, vault: &R2CredentialVault) -> Result<(), String> {
    let plaintext = serde_json::to_vec(vault)
        .map_err(|error| format!("R2_CREDENTIAL_SERIALIZE_FAILED: {error}"))?;
    let encrypted = dpapi_protect(&plaintext)?;
    let contents = format!("{VAULT_HEADER}\n{}\n", hex_encode(&encrypted));
    write_atomic(&vault_path(app)?, contents.as_bytes())
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "R2_CREDENTIAL_PATH_INVALID".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("R2_CREDENTIAL_DIR_CREATE_FAILED: {error}"))?;

    let temporary = path.with_extension("dat.tmp");
    let backup = path.with_extension("dat.bak");
    fs::write(&temporary, contents)
        .map_err(|error| format!("R2_CREDENTIAL_WRITE_FAILED: {error}"))?;

    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    let had_original = path.exists();
    if had_original {
        fs::rename(path, &backup)
            .map_err(|error| format!("R2_CREDENTIAL_BACKUP_FAILED: {error}"))?;
    }

    if let Err(error) = fs::rename(&temporary, path) {
        if had_original {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("R2_CREDENTIAL_COMMIT_FAILED: {error}"));
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
        return Err("R2_CREDENTIAL_FORMAT_INVALID: encrypted payload is not valid hex".to_string());
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
        _ => Err("R2_CREDENTIAL_FORMAT_INVALID: encrypted payload is not valid hex".to_string()),
    }
}

#[cfg(windows)]
fn dpapi_protect(input: &[u8]) -> Result<Vec<u8>, String> {
    dpapi::protect(input)
}

#[cfg(not(windows))]
fn dpapi_protect(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("R2_CREDENTIAL_DPAPI_UNAVAILABLE: credential profiles require Windows".to_string())
}

#[cfg(windows)]
fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    dpapi::unprotect(input)
}

#[cfg(not(windows))]
fn dpapi_unprotect(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("R2_CREDENTIAL_DPAPI_UNAVAILABLE: credential profiles require Windows".to_string())
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
            .map_err(|_| "R2_CREDENTIAL_DPAPI_FAILED: payload is too large".to_string())?;
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
                "R2_CREDENTIAL_DPAPI_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }

        if output_blob.pb_data.is_null() {
            return Err("R2_CREDENTIAL_DPAPI_FAILED: Windows returned an empty buffer".to_string());
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
    use super::{
        hex_decode, hex_encode, mask_access_key, to_summary, StoredR2CredentialProfile,
    };

    #[test]
    fn encrypted_payload_hex_round_trips() {
        let raw = b"\0r2-secret\xff";
        let encoded = hex_encode(raw);
        assert_eq!(hex_decode(&encoded).unwrap(), raw);
    }

    #[test]
    fn public_summary_never_contains_full_keys() {
        let stored = StoredR2CredentialProfile {
            id: "r2-test".to_string(),
            name: "Salon".to_string(),
            account_id: "account-123".to_string(),
            access_key_id: "ACCESS-SECRET-1234".to_string(),
            secret_access_key: "TOP-SECRET-VALUE".to_string(),
        };
        let summary = to_summary(&stored);
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(serialized.contains("****1234"));
        assert!(!serialized.contains("ACCESS-SECRET-1234"));
        assert!(!serialized.contains("TOP-SECRET-VALUE"));
        assert!(summary.has_secret);
    }

    #[test]
    fn access_key_preview_only_keeps_last_four_characters() {
        assert_eq!(mask_access_key("ABCDEF1234"), "****1234");
        assert_eq!(mask_access_key(""), "****");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_uses_current_windows_user() {
        let raw = b"credential-profile-round-trip";
        let encrypted = super::dpapi_protect(raw).unwrap();
        assert_ne!(encrypted, raw);
        assert_eq!(super::dpapi_unprotect(&encrypted).unwrap(), raw);
    }
}
