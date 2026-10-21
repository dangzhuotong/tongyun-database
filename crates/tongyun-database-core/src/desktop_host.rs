//! Locate the desktop data directory and a usable Node.js for the sidecar.
//! The sidecar is the existing `src/server.mjs`. CLI and MCP stay on that
//! same Node entry so the change-control checks are not reimplemented.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::legacy_config::{self, PasswordMigration};
use crate::secret_store::{migrate_app_secrets, SecretStoreError};

#[derive(Debug)]
pub struct PrepareReport {
    pub dir: PathBuf,
    pub imported_from: Option<PathBuf>,
    pub passwords: PasswordMigration,
    pub keychain: crate::secret_store::MigrationReport,
    pub retired: Vec<PathBuf>,
}

pub fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("tongyun-database")
}

/// `dirs::config_dir()` is `~/Library/Application Support` on macOS, which is
/// where the previous browser launcher stored `sandbox.sqlite` and
/// `connections.private.json`.
pub fn prepare_desktop_dir(
    dest: &Path,
    candidates: &[PathBuf],
) -> Result<PrepareReport, SecretStoreError> {
    let mut imported_from = None;
    for candidate in candidates {
        if candidate.is_dir() && legacy_config::import_tree(dest, candidate)? {
            imported_from = Some(candidate.clone());
            break;
        }
    }
    if imported_from.is_none() {
        crate::secret_store::ensure_private_dir(dest)?;
    }
    let keychain = migrate_app_secrets(dest)?;
    let passwords = legacy_config::migrate_connection_passwords(dest)?;
    let retired = legacy_config::retire_imported_source(dest)?;
    Ok(PrepareReport {
        dir: dest.to_path_buf(),
        imported_from,
        passwords,
        keychain,
        retired,
    })
}

pub fn node_version_supported(version: &str) -> bool {
    let major = version
        .split(['.', ' ', '\n'])
        .next()
        .unwrap_or("0")
        .parse::<u32>()
        .unwrap_or(0);
    major >= 24
}

pub fn find_node(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        return require_node(path.to_path_buf());
    }
    if let Ok(from_env) = std::env::var("TONGYUN_NODE") {
        if !from_env.is_empty() {
            return require_node(PathBuf::from(from_env));
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let path_env = std::env::var("PATH").unwrap_or_default();
    let candidates = node_candidates(&home, &path_env);
    let mut failure = match pick_node(&candidates, probe_node) {
        Ok(path) => return Ok(path),
        Err(message) => message,
    };
    if let Some(from_shell) = node_from_login_shell() {
        match probe_node(&from_shell) {
            Probe::Version(version) if node_version_supported(&version) => return Ok(from_shell),
            Probe::Version(version) => {
                failure = node_missing_message(Some((from_shell.as_path(), version.as_str())));
            }
            Probe::Missing | Probe::Failed => {}
        }
    }
    Err(failure)
}

enum Probe {
    Missing,
    Failed,
    Version(String),
}

fn probe_node(path: &Path) -> Probe {
    if !path.is_file() {
        return Probe::Missing;
    }
    let output = Command::new(path)
        .arg("-p")
        .arg("process.versions.node")
        .output();
    let Ok(output) = output else {
        return Probe::Failed;
    };
    if !output.status.success() {
        return Probe::Failed;
    }
    Probe::Version(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn require_node(path: PathBuf) -> Result<PathBuf, String> {
    match probe_node(&path) {
        Probe::Version(version) if node_version_supported(&version) => Ok(path),
        Probe::Version(version) => Err(node_missing_message(Some((path.as_path(), &version)))),
        Probe::Missing => Err(format!(
            "找不到 Node.js：{}。{}",
            path.display(),
            node_missing_message(None)
        )),
        Probe::Failed => Err(format!("无法运行 Node.js：{}", path.display())),
    }
}

fn pick_node(
    candidates: &[PathBuf],
    mut probe: impl FnMut(&Path) -> Probe,
) -> Result<PathBuf, String> {
    let mut seen_old: Option<(PathBuf, String)> = None;
    for candidate in candidates {
        match probe(candidate) {
            Probe::Version(version) if node_version_supported(&version) => {
                return Ok(candidate.clone());
            }
            Probe::Version(version) => {
                if seen_old.is_none() {
                    seen_old = Some((candidate.clone(), version));
                }
            }
            Probe::Missing | Probe::Failed => {}
        }
    }
    Err(node_missing_message(
        seen_old
            .as_ref()
            .map(|(path, version)| (path.as_path(), version.as_str())),
    ))
}

fn node_missing_message(seen: Option<(&Path, &str)>) -> String {
    let mut message = "找不到可用的 Node.js 24。从访达打开时 PATH 很短，已查找 PATH、Homebrew、Volta、fnm、nvm、asdf，以及登录 shell。请安装 Node.js 24 或更高版本（https://nodejs.org），或把 TONGYUN_NODE 设为 node 可执行文件的绝对路径。".to_string();
    if let Some((path, version)) = seen {
        message.push_str(&format!(
            " 当前看到的是 Node.js {version}（{}），版本不够。",
            path.display()
        ));
    }
    message
}

pub fn node_candidates(home: &Path, path_env: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let name = node_file_name();
    for dir in std::env::split_paths(path_env) {
        push_unique(&mut out, dir.join(name));
    }
    for fixed in [
        "/opt/homebrew/bin/node",
        "/opt/homebrew/opt/node@24/bin/node",
        "/usr/local/bin/node",
        "/usr/local/opt/node@24/bin/node",
        "/usr/bin/node",
    ] {
        push_unique(&mut out, PathBuf::from(fixed));
    }
    push_unique(&mut out, home.join(".volta/bin").join(name));
    push_unique(&mut out, home.join(".asdf/shims").join(name));
    push_unique(
        &mut out,
        home.join(".local/share/fnm/aliases/default/bin").join(name),
    );
    push_unique(&mut out, home.join(".fnm/aliases/default/bin").join(name));
    push_unique(
        &mut out,
        home.join("Library/Application Support/fnm/aliases/default/bin")
            .join(name),
    );
    push_sorted_version_bins(
        &mut out,
        &home.join(".nvm/versions/node"),
        &format!("bin/{name}"),
    );
    for root in [
        home.join(".local/share/fnm/node-versions"),
        home.join(".fnm/node-versions"),
        home.join("Library/Application Support/fnm/node-versions"),
    ] {
        push_sorted_version_bins(&mut out, &root, &format!("installation/bin/{name}"));
    }
    push_sorted_version_bins(
        &mut out,
        &home.join(".asdf/installs/nodejs"),
        &format!("bin/{name}"),
    );
    out
}

fn node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn push_unique(out: &mut Vec<PathBuf>, path: PathBuf) {
    if !out.iter().any(|existing| existing == &path) {
        out.push(path);
    }
}

fn push_sorted_version_bins(out: &mut Vec<PathBuf>, root: &Path, suffix: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut bins = Vec::new();
    for entry in entries.flatten() {
        let bin = entry.path().join(suffix);
        if bin.is_file() {
            bins.push((version_key(&entry.file_name().to_string_lossy()), bin));
        }
    }
    bins.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, bin) in bins {
        push_unique(out, bin);
    }
}

fn version_key(name: &str) -> Vec<u32> {
    name.trim_start_matches('v')
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

fn node_from_login_shell() -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    for shell in ["zsh", "bash"] {
        let mut command = Command::new(shell);
        command.args(["-lic", "command -v node"]);
        let Some(output) = output_with_timeout(command, Duration::from_secs(3)) else {
            continue;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(line) = text
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('/'))
            .last()
        else {
            continue;
        };
        let path = PathBuf::from(line);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn output_with_timeout(mut command: Command, timeout: Duration) -> Option<std::process::Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_end(&mut stdout);
                }
                if !status.success() {
                    return None;
                }
                return Some(std::process::Output {
                    status,
                    stdout,
                    stderr: Vec::new(),
                });
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
}

pub fn command_owns_sidecar(cmdline: &str, data_dir: &Path) -> bool {
    let dir = data_dir.to_string_lossy();
    if cmdline.is_empty() || dir.is_empty() {
        return false;
    }
    cmdline.contains("server.mjs") && cmdline.contains(dir.as_ref())
}

pub fn is_our_sidecar(pid: u32, data_dir: &Path) -> bool {
    let Some(cmdline) = read_process_command(pid) else {
        return false;
    };
    command_owns_sidecar(&cmdline, data_dir)
}

pub fn read_process_command(pid: u32) -> Option<String> {
    if pid <= 1 {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        let raw = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        if raw.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&raw).replace('\0', " ");
        let text = text.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("ps")
            .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
    #[cfg(windows)]
    {
        let script =
            format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine");
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = pid;
        None
    }
}

pub fn resolve_server_script(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join("src/server.mjs"))
        .find(|path| path.is_file())
}

pub fn resolve_secrets_command(explicit: Option<&Path>, exe: &Path) -> (PathBuf, Vec<String>) {
    if let Some(path) = explicit {
        if path.is_file() {
            return (path.to_path_buf(), Vec::new());
        }
    }
    if let Some(dir) = exe.parent() {
        let sibling = dir.join(secrets_name());
        if sibling.is_file() {
            return (sibling, Vec::new());
        }
    }
    (exe.to_path_buf(), vec!["--secrets".to_string()])
}

fn secrets_name() -> &'static str {
    if cfg!(windows) {
        "tongyun-database-secrets.exe"
    } else {
        "tongyun-database-secrets"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn node_24_is_required() {
        assert!(node_version_supported("24.14.0"));
        assert!(node_version_supported("24"));
        assert!(!node_version_supported("22.23.3"));
        assert!(!node_version_supported(""));
    }

    #[test]
    fn server_script_resolves_from_a_root() {
        let dir = std::env::temp_dir().join(format!("tongyun-db-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/server.mjs"), "export {}\n").unwrap();
        let found = resolve_server_script(&[dir.join("missing"), dir.clone()]).unwrap();
        assert!(found.ends_with("src/server.mjs"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_command_falls_back_to_the_desktop_binary() {
        let exe = PathBuf::from("/tmp/tongyun-database-desktop");
        let (bin, prefix) = resolve_secrets_command(None, &exe);
        assert_eq!(bin, exe);
        assert_eq!(prefix, vec!["--secrets".to_string()]);
    }

    #[test]
    fn node_candidates_prefer_newer_version_managers() {
        let home = std::env::temp_dir().join(format!("tongyun-node-home-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".nvm/versions/node/v22.0.0/bin")).unwrap();
        fs::write(home.join(".nvm/versions/node/v22.0.0/bin/node"), b"old").unwrap();
        fs::create_dir_all(home.join(".nvm/versions/node/v24.14.0/bin")).unwrap();
        fs::write(home.join(".nvm/versions/node/v24.14.0/bin/node"), b"new").unwrap();
        let found = node_candidates(&home, "/usr/bin");
        let text: Vec<String> = found
            .iter()
            .map(|path| path.display().to_string())
            .collect();
        let newer = text
            .iter()
            .position(|path| path.contains("v24.14.0"))
            .unwrap();
        let older = text
            .iter()
            .position(|path| path.contains("v22.0.0"))
            .unwrap();
        assert!(newer < older);
        assert!(text.iter().any(|path| path.ends_with(".volta/bin/node")));
        assert!(text
            .iter()
            .any(|path| path.ends_with("fnm/aliases/default/bin/node")));
        assert!(text.iter().any(|path| path.ends_with("/usr/bin/node")));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn an_older_node_does_not_hide_a_later_node_24() {
        let old = PathBuf::from("/usr/bin/node");
        let new = PathBuf::from("/opt/homebrew/bin/node");
        let chosen = super::pick_node(&[old.clone(), new.clone()], |path| {
            if path == &old {
                super::Probe::Version("22.23.3".to_string())
            } else if path == &new {
                super::Probe::Version("24.14.0".to_string())
            } else {
                super::Probe::Missing
            }
        })
        .unwrap();
        assert_eq!(chosen, new);
    }

    #[test]
    fn missing_node_explains_finder_path_and_the_override() {
        let err = super::pick_node(&[PathBuf::from("/usr/bin/node")], |_| {
            super::Probe::Version("20.0.0".to_string())
        })
        .unwrap_err();
        assert!(err.contains("访达"));
        assert!(err.contains("TONGYUN_NODE"));
        assert!(err.contains("nodejs.org"));
        assert!(err.contains("20.0.0"));
        assert!(err.contains("/usr/bin/node"));
    }

    #[test]
    fn command_line_must_name_the_server_and_the_data_dir() {
        let dir = Path::new("/tmp/tongyun-data");
        assert!(command_owns_sidecar(
            "node /app/src/server.mjs --data-dir /tmp/tongyun-data",
            dir
        ));
        assert!(!command_owns_sidecar("node /app/src/server.mjs", dir));
        assert!(!command_owns_sidecar(
            "python /tmp/tongyun-data/other.py",
            dir
        ));
        assert!(!command_owns_sidecar("", dir));
    }

    #[cfg(unix)]
    #[test]
    fn an_unrelated_process_is_not_our_sidecar() {
        let data = std::env::temp_dir().join(format!("tongyun-sidecar-dir-{}", std::process::id()));
        fs::create_dir_all(&data).unwrap();
        let mut other = Command::new("sleep").arg("30").spawn().unwrap();
        assert!(!is_our_sidecar(other.id(), &data));
        let mut ours = Command::new("python3")
            .arg("-c")
            .arg("import time; time.sleep(30)")
            .arg("server.mjs")
            .arg("--data-dir")
            .arg(&data)
            .spawn()
            .unwrap();
        let mut matched = false;
        let mut cmdline = None;
        for _ in 0..20 {
            cmdline = super::read_process_command(ours.id());
            matched = cmdline
                .as_deref()
                .is_some_and(|text| command_owns_sidecar(text, &data));
            if matched {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _ = other.kill();
        let _ = ours.kill();
        let _ = other.wait();
        let _ = ours.wait();
        assert!(matched, "cmdline={cmdline:?} dir={}", data.display());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn prepare_imports_sqlite_without_the_working_directory() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let source = std::env::temp_dir().join(format!("tongyun-prep-src-{nanos}"));
        let dest = std::env::temp_dir().join(format!("tongyun-prep-dst-{nanos}"));
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&dest);
        fs::create_dir_all(&source).unwrap();
        {
            let conn = rusqlite::Connection::open(source.join("sandbox.sqlite")).unwrap();
            conn.execute_batch("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (7);")
                .unwrap();
        }
        let report = prepare_desktop_dir(&dest, std::slice::from_ref(&source)).unwrap();
        assert_eq!(report.imported_from.as_deref(), Some(source.as_path()));
        assert!(report.retired.is_empty());
        let copied = rusqlite::Connection::open(dest.join("sandbox.sqlite")).unwrap();
        let id: i64 = copied
            .query_row("SELECT id FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(id, 7);
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn workspace_manifests_do_not_depend_on_a_keychain() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        for relative in [
            "Cargo.toml",
            "crates/tongyun-database-core/Cargo.toml",
            "apps/desktop/src-tauri/Cargo.toml",
        ] {
            let text = fs::read_to_string(root.join(relative)).unwrap_or_else(|_| {
                panic!("missing {relative}");
            });
            let lowered = text.to_ascii_lowercase();
            assert!(!lowered.contains("keyring"), "{relative} links keyring");
            assert!(
                !lowered.contains("stronghold"),
                "{relative} links stronghold"
            );
        }
    }
}
