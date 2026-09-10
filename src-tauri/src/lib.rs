mod admin_api;
mod release_manager;
mod release_manager_v2;

use tauri::Manager;

#[tauri::command]
fn app_info() -> String {
    "Key Manager Desktop / Tauri".to_string()
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
            release_manager_v2::package_key_manager_release,
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
