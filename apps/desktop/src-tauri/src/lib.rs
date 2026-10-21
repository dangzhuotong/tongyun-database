use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;
use tongyun_database_core::{
    app_config_dir, find_node, is_our_sidecar, load_settings, prepare_desktop_dir,
    resolve_secrets_command, resolve_server_script, save_settings, AppSettings,
};

struct Host {
    gate: Arc<Mutex<()>>,
    child: Arc<Mutex<Option<Child>>>,
    url: Arc<Mutex<Option<String>>>,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            gate: Arc::new(Mutex::new(())),
            child: Arc::new(Mutex::new(None)),
            url: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(serde::Serialize)]
struct SettingsView {
    theme: String,
    #[serde(rename = "dataDir")]
    data_dir: String,
}

fn report(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[tauri::command]
async fn workbench_url(
    app: tauri::AppHandle,
    host: tauri::State<'_, Host>,
) -> Result<String, String> {
    let gate = Arc::clone(&host.gate);
    let child_slot = Arc::clone(&host.child);
    let url_slot = Arc::clone(&host.url);
    let resource = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(url) = url_slot
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
        {
            if endpoint_alive(&url) {
                return Ok(url);
            }
        }
        if let Some(mut old) = child_slot
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            let _ = old.kill();
            let _ = old.wait();
        }
        let dir = app_config_dir();
        let candidates = tongyun_database_core::candidate_dirs(&[]);
        let prepared = prepare_desktop_dir(&dir, &candidates).map_err(report)?;
        note_retired(&dir, &prepared.retired);
        let node = find_node(None)?;
        let roots = server_roots(resource.as_deref());
        let server = resolve_server_script(&roots)
            .ok_or_else(|| "找不到工作台服务 src/server.mjs".to_string())?;
        let exe = std::env::current_exe().map_err(report)?;
        let (secrets_bin, prefix) = resolve_secrets_command(None, &exe);
        stop_previous(&dir.join("sidecar.pid"), &dir);
        let _ = fs::remove_file(dir.join("endpoint.json"));
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("server.log"))
            .map_err(report)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir.join("server.log"), fs::Permissions::from_mode(0o600));
        }
        let stderr = log.try_clone().map_err(report)?;
        let mut command = Command::new(&node);
        command
            .arg(&server)
            .arg("--data-dir")
            .arg(&dir)
            .current_dir(
                server
                    .parent()
                    .and_then(Path::parent)
                    .unwrap_or(Path::new(".")),
            )
            .env("TONGYUN_DATA_DIR", &dir)
            .env("TONGYUN_DATABASE_PORT", "0")
            .env("TONGYUN_DESKTOP", "1")
            .env("TONGYUN_SECRETS_BIN", &secrets_bin)
            .env("TONGYUN_SECRETS_PREFIX", prefix.join(" "))
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(stderr));
        #[cfg(debug_assertions)]
        {
            command.env("TONGYUN_DESKTOP_DEV", "1");
        }
        let child = command
            .spawn()
            .map_err(|err| format!("工作台进程启动失败：{err}"))?;
        let _ = fs::write(dir.join("sidecar.pid"), child.id().to_string());
        let url = wait_endpoint(
            &dir.join("endpoint.json"),
            &child_slot,
            child,
            Duration::from_secs(20),
        )?;
        *url_slot.lock().unwrap_or_else(|err| err.into_inner()) = Some(url.clone());
        Ok(url)
    })
    .await
    .map_err(report)?
}

fn server_roots(resource: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(resource) = resource {
        roots.push(resource.join("sidecar"));
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    roots
}

fn wait_endpoint(
    path: &Path,
    slot: &Mutex<Option<Child>>,
    child: Child,
    timeout: Duration,
) -> Result<String, String> {
    *slot.lock().unwrap_or_else(|err| err.into_inner()) = Some(child);
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(child) = slot.lock().unwrap_or_else(|err| err.into_inner()).as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "工作台进程已退出（{status}）。请查看数据目录里的 server.log"
                ));
            }
        }
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(url) = value.get("url").and_then(|item| item.as_str()) {
                    if endpoint_alive(url) {
                        return Ok(url.to_string());
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("工作台启动超时。请查看数据目录里的 server.log".to_string())
}

fn endpoint_alive(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let hostport = rest.split('/').next().unwrap_or("");
    let Ok(addr) = hostport.parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn note_retired(dir: &Path, retired: &[PathBuf]) {
    if retired.is_empty() {
        return;
    }
    let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("server.log"))
    else {
        return;
    };
    let names = retired
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let _ = writeln!(
        log,
        "已删除旧目录中的 connection-key，只保留无法单独解密的密文：{names}。密码在当前数据目录的 secrets.vault。"
    );
}

fn stop_previous(pid_path: &Path, data_dir: &Path) {
    let Ok(text) = fs::read_to_string(pid_path) else {
        return;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        return;
    };
    if pid <= 1 || pid == std::process::id() {
        return;
    }
    if !is_our_sidecar(pid, data_dir) {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    std::thread::sleep(Duration::from_millis(200));
}

#[tauri::command]
fn load_app_settings() -> Result<SettingsView, String> {
    let dir = app_config_dir();
    let settings = load_settings(&dir).unwrap_or_default();
    Ok(view(&dir, &settings))
}

#[tauri::command]
fn save_app_settings(theme: String) -> Result<SettingsView, String> {
    let dir = app_config_dir();
    let settings = AppSettings::parse(&theme).map_err(|_| "主题无效".to_string())?;
    save_settings(&dir, &settings).map_err(report)?;
    Ok(view(&dir, &settings))
}

fn view(dir: &Path, settings: &AppSettings) -> SettingsView {
    SettingsView {
        theme: settings.theme.clone(),
        data_dir: dir.display().to_string(),
    }
}

#[cfg(target_os = "macos")]
fn activate_macos_app() {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
    };
    let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    ns_app.activateIgnoringOtherApps(true);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Host::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = handle;
                    activate_macos_app();
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workbench_url,
            load_app_settings,
            save_app_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building tongyun-database")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(host) = app.try_state::<Host>() {
                    if let Some(mut child) = host
                        .child
                        .lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .take()
                    {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use tongyun_database_core::node_version_supported;

    #[test]
    fn node_gate_matches_the_engine_requirement() {
        assert!(node_version_supported("24.14.0"));
        assert!(!node_version_supported("22.23.3"));
    }
}
