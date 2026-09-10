mod admin_api;
mod release_manager;
mod release_manager_v2;

use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
fn app_info() -> String {
    "Key Manager Desktop / Tauri".to_string()
}

#[tauri::command]
fn package_key_manager_release(
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
            admin_api::ensure_admin_api,
            admin_api::admin_api_runtime_status,
            release_manager::get_release_manager_config,
            release_manager::save_release_manager_config,
            package_key_manager_release,
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
    use super::app_info;

    #[test]
    fn app_info_identifies_desktop_runtime() {
        assert_eq!(app_info(), "Key Manager Desktop / Tauri");
    }
}
