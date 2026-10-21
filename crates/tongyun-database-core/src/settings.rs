//! Desktop preferences. Theme and similar UI state live in plaintext
//! `settings.json`. Database passwords never go through this file.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::secret_store::{self, SecretStoreError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSettings {
    pub theme: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
        }
    }
}

impl AppSettings {
    pub fn parse(theme: &str) -> Result<Self, SecretStoreError> {
        if !matches!(theme, "system" | "light" | "dark") {
            return Err(SecretStoreError::Corrupt);
        }
        Ok(Self {
            theme: theme.to_string(),
        })
    }
}

pub fn load_settings(dir: &Path) -> Result<AppSettings, SecretStoreError> {
    secret_store::ensure_private_dir(dir)?;
    let path = dir.join("settings.json");
    let Some(bytes) = secret_store::read_regular_file(&path)? else {
        return Ok(AppSettings::default());
    };
    let settings: AppSettings =
        serde_json::from_slice(&bytes).map_err(|_| SecretStoreError::Corrupt)?;
    AppSettings::parse(&settings.theme)
}

/// Write `settings.json` at mode 0600. Does not open the secret vault.
pub fn save_settings(dir: &Path, settings: &AppSettings) -> Result<(), SecretStoreError> {
    let checked = AppSettings::parse(&settings.theme)?;
    let bytes = serde_json::to_vec(&checked).map_err(|_| SecretStoreError::Corrupt)?;
    secret_store::write_private_file(&dir.join("settings.json"), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tongyun-db-settings-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn three_setting_saves_do_not_create_a_vault() {
        let dir = temp_dir();
        for theme in ["light", "dark", "system"] {
            save_settings(&dir, &AppSettings::parse(theme).unwrap()).unwrap();
        }
        let settings = load_settings(&dir).unwrap();
        assert_eq!(settings.theme, "system");
        assert!(!dir.join("secrets.vault").exists());
        assert!(!dir.join("secret.key").exists());
        let mode = fs::metadata(dir.join("settings.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unknown_theme() {
        assert!(AppSettings::parse("keychain").is_err());
    }

    #[test]
    fn settings_file_rejects_a_password_field() {
        let dir = temp_dir();
        crate::secret_store::write_private_file(
            &dir.join("settings.json"),
            br#"{"theme":"light","password":"nope"}"#,
        )
        .unwrap();
        assert!(load_settings(&dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
