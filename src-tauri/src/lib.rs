mod release_manager;

#[tauri::command]
fn app_info() -> String {
    "Key Manager Desktop / Tauri".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_info,
            release_manager::get_release_manager_config,
            release_manager::save_release_manager_config,
            release_manager::package_key_manager,
            release_manager::check_key_manager_update,
            release_manager::install_key_manager_update,
            release_manager::package_external_application
        ])
        .run(tauri::generate_context!())
        .expect("error while running Key Manager");
}

#[cfg(test)]
mod tests {
    use super::app_info;

    #[test]
    fn app_info_identifies_desktop_runtime() {
        assert_eq!(app_info(), "Key Manager Desktop / Tauri");
    }
}
