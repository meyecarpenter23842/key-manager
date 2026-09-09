#[tauri::command]
fn app_info() -> String {
    "Key Manager Desktop / Tauri".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
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
