//! Locate the desktop data directory and a usable Node.js for the sidecar.
//! The sidecar is the existing `src/server.mjs`. CLI and MCP stay on that
//! same Node entry so the change-control checks are not reimplemented.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::legacy_config::{self, PasswordMigration};
use crate::secret_store::{migrate_app_secrets, SecretStoreError};

#[derive(Debug)]
pub struct PrepareReport {
    pub dir: PathBuf,
    pub imported_from: Option<PathBuf>,
    pub passwords: PasswordMigration,
    pub keychain: crate::secret_store::MigrationReport,
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
    Ok(PrepareReport {
        dir: dest.to_path_buf(),
        imported_from,
        passwords,
        keychain,
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
        return check_node(path.to_path_buf());
    }
    if let Ok(from_env) = std::env::var("TONGYUN_NODE") {
        if !from_env.is_empty() {
            return check_node(PathBuf::from(from_env));
        }
    }
    if let Some(path) = which("node") {
        return check_node(path);
    }
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return check_node(path);
        }
    }
    Err("需要 Node.js 24 或更高版本。请安装后再打开。".to_string())
}

fn check_node(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err(format!("找不到 Node.js：{}", path.display()));
    }
    let output = Command::new(&path)
        .arg("-p")
        .arg("process.versions.node")
        .output()
        .map_err(|_| format!("无法运行 Node.js：{}", path.display()))?;
    if !output.status.success() {
        return Err(format!("无法运行 Node.js：{}", path.display()));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !node_version_supported(&version) {
        return Err(format!("当前 Node.js 为 {version}，需要 24 或更高版本"));
    }
    Ok(path)
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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
