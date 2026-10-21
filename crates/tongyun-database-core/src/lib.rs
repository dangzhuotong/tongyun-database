//! Shared pieces for the tongyun-database desktop shell and the Node sidecar.
//!
//! Database engines, change control, the CLI, and the MCP server stay in Node.
//! This crate owns the file secret store (no OS keychain), migration of the
//! existing encrypted connection file, and the settings file the desktop shell
//! writes when the user saves preferences.

pub mod desktop_host;
pub mod legacy_config;
pub mod secret_store;
pub mod settings;
pub mod vault_cli;

pub use desktop_host::{
    app_config_dir, command_owns_sidecar, find_node, is_our_sidecar, node_version_supported,
    prepare_desktop_dir, resolve_secrets_command, resolve_server_script, PrepareReport,
};
pub use legacy_config::{candidate_dirs, migrate_connection_passwords, PasswordMigration};
pub use secret_store::{
    migrate_app_secrets, FileSecretStore, MigrationReport, SecretStoreError, StorePaths,
};
pub use settings::{load_settings, save_settings, AppSettings};
