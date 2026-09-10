mod admin_api;
mod release_manager;
mod release_manager_v2;

use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[tauri::command]
fn app_info() -> String {
    "Key Manager Desktop / Tauri".to_string()
}

fn validate_database_url(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty()
        || value.contains('\r')
        || value.contains('\n')
        || !(value.starts_with("postgresql://") || value.starts_with("postgres://"))
    {
        return Err(
            "ADMIN_API_DATABASE_URL_INVALID: expected a postgresql:// or postgres:// connection URL"
                .to_string(),
        );
    }
    Ok(value)
}

fn upsert_env_setting(raw: &str, key: &str, value: &str) -> String {
    let mut output = Vec::new();
    let mut replaced = false;

    for line in raw.lines() {
        let is_target = line
            .split_once('=')
            .map(|(candidate, _)| candidate.trim() == key)
            .unwrap_or(false);
        if is_target {
            if !replaced {
                output.push(format!("{key}={value}"));
                replaced = true;
            }
        } else {
            output.push(line.to_string());
        }
    }

    if !replaced {
        output.push(format!("{key}={value}"));
    }

    format!("{}\n", output.join("\n"))
}

fn write_text_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "ADMIN_API_CONFIG_PATH_INVALID".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("ADMIN_API_CONFIG_DIR_CREATE_FAILED: {error}"))?;

    let temp = path.with_extension("env.tmp");
    let backup = path.with_extension("env.bak");
    fs::write(&temp, contents)
        .map_err(|error| format!("ADMIN_API_CONFIG_WRITE_FAILED: {error}"))?;

    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    let had_original = path.exists();
    if had_original {
        fs::rename(path, &backup)
            .map_err(|error| format!("ADMIN_API_CONFIG_BACKUP_FAILED: {error}"))?;
    }

    if let Err(error) = fs::rename(&temp, path) {
        if had_original {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(format!("ADMIN_API_CONFIG_COMMIT_FAILED: {error}"));
    }

    if had_original {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

#[tauri::command]
fn configure_admin_api(app: AppHandle, database_url: String) -> Result<(), String> {
    let database_url = validate_database_url(&database_url)?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("ADMIN_API_CONFIG_DIR_FAILED: {error}"))?;
    let config_path = config_dir.join("admin-api.env");
    let existing = if config_path.is_file() {
        fs::read_to_string(&config_path)
            .map_err(|error| format!("ADMIN_API_CONFIG_READ_FAILED: {error}"))?
    } else {
        String::new()
    };
    let updated = upsert_env_setting(&existing, "DATABASE_URL", database_url);
    write_text_atomic(&config_path, &updated)
}

#[tauri::command]
fn package_key_manager_release_safe(
    app: AppHandle,
    new_version: String,
    release_notes: String,
) -> Result<release_manager::PackageResult, String> {
    let config = release_manager::get_release_manager_config(app.clone())?;
    let normalized = new_version.trim().trim_start_matches('v');
    let safe_segment = !normalized.is_empty()
        && normalized != "."
        && normalized != ".."
        && normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character));
    let version_dir =
        safe_segment.then(|| PathBuf::from(&config.key_manager_update_dir).join(normalized));
    let existed_before = version_dir.as_ref().is_some_and(|path| path.exists());

    let result = release_manager_v2::package_key_manager_release(app, new_version, release_notes);
    if result.is_err() && !existed_before {
        if let Some(path) = version_dir.filter(|path| path.exists()) {
            if let Err(cleanup_error) = fs::remove_dir_all(&path) {
                let original = result.err().unwrap_or_else(|| "RELEASE_FAILED".to_string());
                return Err(format!(
                    "{original}\nRELEASE_DIR_ROLLBACK_FAILED: {}: {cleanup_error}",
                    path.display()
                ));
            }
        }
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(admin_api::AdminApiState::default())
        .setup(|app| {
            admin_api::ensure_on_startup(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            configure_admin_api,
            admin_api::ensure_admin_api,
            admin_api::admin_api_runtime_status,
            release_manager::get_release_manager_config,
            release_manager::save_release_manager_config,
            package_key_manager_release_safe,
            release_manager::check_key_manager_update,
            release_manager::install_key_manager_update,
            release_manager::package_external_application
        ])
        .build(tauri::generate_context!())
        .expect("error while building Key Manager");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app_handle.state::<admin_api::AdminApiState>();
            admin_api::stop_managed(&state);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{upsert_env_setting, validate_database_url};

    #[test]
    fn database_url_validation_accepts_postgres_urls_only() {
        assert!(validate_database_url("postgresql://user:pass@localhost/db").is_ok());
        assert!(validate_database_url("postgres://user:pass@localhost/db").is_ok());
        assert!(validate_database_url("http://localhost/db").is_err());
        assert!(validate_database_url("postgresql://localhost/db\nOTHER=value").is_err());
    }

    #[test]
    fn database_url_update_preserves_other_server_settings() {
        let raw = "ADMIN_API_PORT=3101\nDATABASE_URL=postgresql://old/db\nSECRET=value\n";
        let updated = upsert_env_setting(raw, "DATABASE_URL", "postgresql://new/db");
        assert!(updated.contains("ADMIN_API_PORT=3101"));
        assert!(updated.contains("SECRET=value"));
        assert!(updated.contains("DATABASE_URL=postgresql://new/db"));
        assert_eq!(updated.matches("DATABASE_URL=").count(), 1);
    }
}
