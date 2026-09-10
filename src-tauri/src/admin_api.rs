use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const API_HOST: &str = "127.0.0.1";
const API_PORT: u16 = 3101;
const API_ORIGINS: &str = "http://localhost:1420,http://tauri.localhost";
const ENV_FILE_NAME: &str = "admin-api.env";

#[derive(Default)]
pub struct AdminApiState {
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminApiRuntimeStatus {
    pub online: bool,
    pub managed: bool,
    pub detail: Option<String>,
}

pub(crate) fn ensure_on_startup(app: AppHandle) {
    thread::spawn(move || {
        let state = app.state::<AdminApiState>();
        let _ = ensure_running_inner(&app, &state);
    });
}

#[tauri::command]
pub(crate) fn ensure_admin_api(
    app: AppHandle,
    state: State<'_, AdminApiState>,
) -> Result<AdminApiRuntimeStatus, String> {
    ensure_running_inner(&app, &state)
}

#[tauri::command]
pub(crate) fn admin_api_runtime_status(
    state: State<'_, AdminApiState>,
) -> Result<AdminApiRuntimeStatus, String> {
    Ok(status(&state))
}

pub(crate) fn stop_managed(state: &AdminApiState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn ensure_running_inner(
    app: &AppHandle,
    state: &AdminApiState,
) -> Result<AdminApiRuntimeStatus, String> {
    if api_health_ok() {
        clear_error(state);
        return Ok(status(state));
    }

    reap_exited_child(state);
    if child_is_running(state) {
        wait_for_health();
        return Ok(status(state));
    }

    let sidecar = sidecar_path(app)?;
    if !sidecar.is_file() {
        let message = format!("ADMIN_API_SIDECAR_NOT_FOUND: {}", sidecar.display());
        set_error(state, message.clone());
        return Err(message);
    }

    let mut runtime_env = load_runtime_env(app)?;
    runtime_env.insert("ADMIN_API_HOST".to_string(), API_HOST.to_string());
    runtime_env.insert("ADMIN_API_PORT".to_string(), API_PORT.to_string());
    runtime_env.insert(
        "ADMIN_API_ALLOWED_ORIGINS".to_string(),
        API_ORIGINS.to_string(),
    );

    if !runtime_env.contains_key("DATABASE_URL") && std::env::var_os("DATABASE_URL").is_none() {
        let expected = app_config_env_path(app)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| ENV_FILE_NAME.to_string());
        let message = format!(
            "ADMIN_API_CONFIG_MISSING: DATABASE_URL is not available. Put server-only settings in {expected} or KEY_MANAGER_ADMIN_API_ENV_FILE."
        );
        set_error(state, message.clone());
        return Err(message);
    }

    let log_path = admin_api_log_path(app)?;
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("ADMIN_API_LOG_DIR_FAILED: {error}"))?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("ADMIN_API_LOG_OPEN_FAILED: {error}"))?;
    let stderr = log
        .try_clone()
        .map_err(|error| format!("ADMIN_API_LOG_CLONE_FAILED: {error}"))?;

    let mut command = Command::new(&sidecar);
    command
        .envs(runtime_env)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("ADMIN_API_START_FAILED: {error}"))?;
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
    clear_error(state);

    wait_for_health();
    reap_exited_child(state);
    let result = status(state);
    if !result.online {
        let message = format!(
            "ADMIN_API_START_TIMEOUT: sidecar did not become healthy on http://{API_HOST}:{API_PORT}; see {}",
            log_path.display()
        );
        set_error(state, message.clone());
        return Err(message);
    }
    Ok(result)
}

fn sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("ADMIN_API_RESOURCE_DIR_FAILED: {error}"))?;
    #[cfg(windows)]
    let name = "key-manager-api.exe";
    #[cfg(not(windows))]
    let name = "key-manager-api";
    Ok(resource_dir.join(name))
}

fn app_config_env_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(ENV_FILE_NAME))
        .map_err(|error| format!("ADMIN_API_CONFIG_DIR_FAILED: {error}"))
}

fn admin_api_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|dir| dir.join("admin-api.log"))
        .map_err(|error| format!("ADMIN_API_LOG_DIR_FAILED: {error}"))
}

fn load_runtime_env(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    let mut candidates = Vec::new();

    if let Some(explicit) = std::env::var_os("KEY_MANAGER_ADMIN_API_ENV_FILE") {
        candidates.push(PathBuf::from(explicit));
    }
    candidates.push(app_config_env_path(app)?);

    let source_env = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join(".env"));
    if let Some(path) = source_env {
        candidates.push(path);
    }

    for path in candidates {
        if !path.is_file() {
            continue;
        }
        for (key, value) in parse_env_file(&path)? {
            if key.starts_with("VITE_") {
                continue;
            }
            env.entry(key).or_insert(value);
        }
        if env.contains_key("DATABASE_URL") {
            break;
        }
    }
    Ok(env)
}

fn parse_env_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("ADMIN_API_ENV_READ_FAILED: {}: {error}", path.display()))?;
    let mut values = HashMap::new();
    for (index, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (key, raw_value) = trimmed.split_once('=').ok_or_else(|| {
            format!(
                "ADMIN_API_ENV_INVALID: {}:{} must be KEY=VALUE",
                path.display(),
                index + 1
            )
        })?;
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(format!(
                "ADMIN_API_ENV_INVALID: {}:{} has invalid key",
                path.display(),
                index + 1
            ));
        }
        let value = unquote_env_value(raw_value.trim());
        values.insert(key.to_string(), value);
    }
    Ok(values)
}

fn unquote_env_value(value: &str) -> String {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn reap_exited_child(state: &AdminApiState) {
    let Ok(mut guard) = state.child.lock() else {
        return;
    };
    let Some(child) = guard.as_mut() else {
        return;
    };
    match child.try_wait() {
        Ok(Some(exit)) => {
            *guard = None;
            set_error(
                state,
                format!("ADMIN_API_EXITED: sidecar exited with {exit}"),
            );
        }
        Ok(None) => {}
        Err(error) => set_error(state, format!("ADMIN_API_STATUS_FAILED: {error}")),
    }
}

fn child_is_running(state: &AdminApiState) -> bool {
    let Ok(mut guard) = state.child.lock() else {
        return false;
    };
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

fn status(state: &AdminApiState) -> AdminApiRuntimeStatus {
    AdminApiRuntimeStatus {
        online: api_health_ok(),
        managed: child_is_running(state),
        detail: state.last_error.lock().ok().and_then(|value| value.clone()),
    }
}

fn set_error(state: &AdminApiState, message: String) {
    if let Ok(mut guard) = state.last_error.lock() {
        *guard = Some(message);
    }
}

fn clear_error(state: &AdminApiState) {
    if let Ok(mut guard) = state.last_error.lock() {
        *guard = None;
    }
}

fn wait_for_health() {
    for _ in 0..30 {
        if api_health_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn api_health_ok() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], API_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:3101\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

#[cfg(test)]
mod tests {
    use super::{parse_env_file, unquote_env_value};
    use std::{fs, time::SystemTime};

    #[test]
    fn env_values_support_simple_quotes() {
        assert_eq!(unquote_env_value("\"abc\""), "abc");
        assert_eq!(unquote_env_value("'abc'"), "abc");
        assert_eq!(unquote_env_value("abc"), "abc");
    }

    #[test]
    fn env_parser_rejects_lines_without_assignment() {
        let mut path = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("key-manager-admin-api-{stamp}.env"));
        fs::write(&path, "DATABASE_URL=postgres://example\nBROKEN").unwrap();
        assert!(parse_env_file(&path).is_err());
        let _ = fs::remove_file(path);
    }
}
