use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const SECRET_FILE: &str = "license-key-encryption.dat";
const SECRET_HEADER: &str = "KM-LICENSE-KEY-DPAPI-V1";
const KEY_BYTES: usize = 32;

pub(crate) fn resolve_or_create(app: &AppHandle) -> Result<String, String> {
    let path = secret_path(app)?;
    let key = if path.is_file() {
        load_secret(&path)?
    } else {
        let mut key = vec![0u8; KEY_BYTES];
        os_random(&mut key)?;
        persist_secret(&path, &key)?;
        key
    };

    if key.len() != KEY_BYTES {
        return Err(format!(
            "LICENSE_KEY_SECRET_INVALID: expected {KEY_BYTES} bytes, got {}",
            key.len()
        ));
    }
    Ok(hex_encode(&key))
}

fn secret_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SECRET_FILE))
        .map_err(|error| format!("LICENSE_KEY_SECRET_DIR_FAILED: {error}"))
}

fn load_secret(path: &Path) -> Result<Vec<u8>, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("LICENSE_KEY_SECRET_READ_FAILED: {}: {error}", path.display()))?;
    let mut lines = raw.lines();
    if lines.next() != Some(SECRET_HEADER) {
        return Err("LICENSE_KEY_SECRET_FORMAT_INVALID: unsupported header".to_string());
    }
    let encoded = lines.collect::<String>();
    if encoded.is_empty() {
        return Err("LICENSE_KEY_SECRET_FORMAT_INVALID: encrypted payload is empty".to_string());
    }
    let encrypted = hex_decode(&encoded)?;
    dpapi_unprotect(&encrypted)
}

fn persist_secret(path: &Path, key: &[u8]) -> Result<(), String> {
    let encrypted = dpapi_protect(key)?;
    let contents = format!("{SECRET_HEADER}\n{}\n", hex_encode(&encrypted));
    write_atomic(path, contents.as_bytes())
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "LICENSE_KEY_SECRET_PATH_INVALID".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("LICENSE_KEY_SECRET_DIR_CREATE_FAILED: {error}"))?;

    let temporary = path.with_extension("dat.tmp");
    let backup = path.with_extension("dat.bak");
    fs::write(&temporary, contents)
        .map_err(|error| format!("LICENSE_KEY_SECRET_WRITE_FAILED: {error}"))?;

    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    let had_original = path.exists();
    if had_original {
        fs::rename(path, &backup)
            .map_err(|error| format!("LICENSE_KEY_SECRET_BACKUP_FAILED: {error}"))?;
    }

    if let Err(error) = fs::rename(&temporary, path) {
        if had_original {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("LICENSE_KEY_SECRET_COMMIT_FAILED: {error}"));
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
        return Err("LICENSE_KEY_SECRET_FORMAT_INVALID: payload is not valid hex".to_string());
    }
    let mut output = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        output.push((hex_nibble(chunk[0])? << 4) | hex_nibble(chunk[1])?);
    }
    Ok(output)
}

fn hex_nibble(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("LICENSE_KEY_SECRET_FORMAT_INVALID: payload is not valid hex".to_string()),
    }
}

#[cfg(windows)]
fn os_random(output: &mut [u8]) -> Result<(), String> {
    windows_crypto::random(output)
}

#[cfg(not(windows))]
fn os_random(_output: &mut [u8]) -> Result<(), String> {
    Err("LICENSE_KEY_SECRET_WINDOWS_REQUIRED: automatic secret provisioning requires Windows"
        .to_string())
}

#[cfg(windows)]
fn dpapi_protect(input: &[u8]) -> Result<Vec<u8>, String> {
    windows_crypto::protect(input)
}

#[cfg(not(windows))]
fn dpapi_protect(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("LICENSE_KEY_SECRET_DPAPI_UNAVAILABLE: automatic secret provisioning requires Windows"
        .to_string())
}

#[cfg(windows)]
fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    windows_crypto::unprotect(input)
}

#[cfg(not(windows))]
fn dpapi_unprotect(_input: &[u8]) -> Result<Vec<u8>, String> {
    Err("LICENSE_KEY_SECRET_DPAPI_UNAVAILABLE: automatic secret provisioning requires Windows"
        .to_string())
}

#[cfg(windows)]
mod windows_crypto {
    use std::{ffi::c_void, ptr, slice};

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x2;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "Bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut c_void,
            buffer: *mut u8,
            buffer_len: u32,
            flags: u32,
        ) -> i32;
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

    pub(super) fn random(output: &mut [u8]) -> Result<(), String> {
        let len = u32::try_from(output.len())
            .map_err(|_| "LICENSE_KEY_SECRET_RANDOM_FAILED: buffer is too large".to_string())?;
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                output.as_mut_ptr(),
                len,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(format!(
                "LICENSE_KEY_SECRET_RANDOM_FAILED: BCryptGenRandom returned 0x{:08x}",
                status as u32
            ));
        }
        Ok(())
    }

    pub(super) fn protect(input: &[u8]) -> Result<Vec<u8>, String> {
        run_dpapi(input, true)
    }

    pub(super) fn unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
        run_dpapi(input, false)
    }

    fn run_dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input_len = u32::try_from(input.len())
            .map_err(|_| "LICENSE_KEY_SECRET_DPAPI_FAILED: payload is too large".to_string())?;
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
                "LICENSE_KEY_SECRET_DPAPI_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }
        if output_blob.pb_data.is_null() {
            return Err("LICENSE_KEY_SECRET_DPAPI_FAILED: Windows returned an empty buffer".to_string());
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
    use super::{hex_decode, hex_encode};

    #[test]
    fn hex_round_trip() {
        let input = b"key-manager-license-secret";
        let encoded = hex_encode(input);
        assert_eq!(hex_decode(&encoded).unwrap(), input);
    }

    #[cfg(windows)]
    #[test]
    fn windows_random_and_dpapi_round_trip() {
        let mut secret = vec![0u8; 32];
        super::os_random(&mut secret).unwrap();
        assert!(secret.iter().any(|byte| *byte != 0));
        let encrypted = super::dpapi_protect(&secret).unwrap();
        assert_ne!(encrypted, secret);
        assert_eq!(super::dpapi_unprotect(&encrypted).unwrap(), secret);
    }
}
