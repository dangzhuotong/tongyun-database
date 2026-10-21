//! Move database passwords out of the Node AES connection file into the
//! file secret store. The connection-key file stays, because the sidecar
//! still encrypts non-secret connection metadata with it. Passwords are
//! removed from that blob only after the vault read-back matches.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroize;

use crate::secret_store::{self, FileSecretStore, SecretStoreError, StorePaths};

const MARKER_NAME: &str = "connections.migrated";
const PRIVATE_NAME: &str = "connections.private.json";
const KEY_NAME: &str = "connection-key";
const SOURCE_POINTER: &str = "legacy-import-source";
const SQLITE_NAME: &str = "sandbox.sqlite";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordMigration {
    pub already_migrated: bool,
    pub imported: usize,
    pub unchanged: usize,
}

impl PasswordMigration {
    fn fresh() -> Self {
        Self {
            already_migrated: false,
            imported: 0,
            unchanged: 0,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    iv: String,
    tag: String,
    data: String,
}

pub fn migrate_connection_passwords(dir: &Path) -> Result<PasswordMigration, SecretStoreError> {
    secret_store::ensure_private_dir(dir)?;
    let _lock = lock_migration(dir)?;
    let marker = dir.join(MARKER_NAME);
    if secret_store::regular_file_exists(&marker)? {
        let mut report = PasswordMigration::fresh();
        report.already_migrated = true;
        return Ok(report);
    }
    let private_path = dir.join(PRIVATE_NAME);
    if !secret_store::regular_file_exists(&private_path)? {
        return Ok(PasswordMigration::fresh());
    }

    let key = read_connection_key(&dir.join(KEY_NAME))?;
    let original =
        secret_store::read_regular_file(&private_path)?.ok_or(SecretStoreError::Corrupt)?;
    let mut plain = decrypt_envelope(&key, &original)?;
    let mut records: Vec<Value> =
        serde_json::from_slice(&plain).map_err(|_| SecretStoreError::Corrupt)?;
    plain.zeroize();

    let mut pending: Vec<(String, String)> = Vec::new();
    for record in &mut records {
        let obj = record.as_object_mut().ok_or(SecretStoreError::Corrupt)?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or(SecretStoreError::Corrupt)?
            .to_string();
        if id.is_empty() || id.contains('/') || id.contains('\0') || id.len() > 80 {
            return Err(SecretStoreError::Corrupt);
        }
        let account = format!("connection/{id}");
        let password = match obj.get("password").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => Some(value.to_string()),
            _ => None,
        };
        if let Some(password) = password {
            pending.push((account.clone(), password));
            obj.remove("password");
            obj.insert("secretAccount".to_string(), json!(account));
        }
    }

    if !pending.is_empty() {
        let mut store = FileSecretStore::open(StorePaths::new(dir))?;
        for (account, password) in &pending {
            store.set(account, password)?;
            match store.get(account)? {
                Some(got) if got == *password => {}
                _ => return Err(SecretStoreError::VerifyFailed),
            }
        }
    }

    let encoded = serde_json::to_vec(&records).map_err(|_| SecretStoreError::Corrupt)?;
    let envelope = encrypt_envelope(&key, &encoded)?;
    let bytes = serde_json::to_vec(&envelope).map_err(|_| SecretStoreError::Corrupt)?;
    secret_store::write_private_file(&private_path, &bytes)?;
    let check = secret_store::read_regular_file(&private_path)?.ok_or(SecretStoreError::Corrupt)?;
    let mut roundtrip = decrypt_envelope(&key, &check)?;
    let verified: Vec<Value> =
        serde_json::from_slice(&roundtrip).map_err(|_| SecretStoreError::Corrupt)?;
    roundtrip.zeroize();
    if verified.len() != records.len() {
        return Err(SecretStoreError::VerifyFailed);
    }
    for record in &verified {
        if record.get("password").is_some() {
            return Err(SecretStoreError::VerifyFailed);
        }
    }
    secret_store::write_private_file(&marker, b"ok\n")?;
    let imported = pending.len();
    for (_, password) in &mut pending {
        password.zeroize();
    }
    let mut report = PasswordMigration::fresh();
    report.imported = imported;
    report.unchanged = records.len() - imported;
    Ok(report)
}

pub fn read_connection_key(path: &Path) -> Result<Vec<u8>, SecretStoreError> {
    let bytes = secret_store::read_regular_file(path)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "connection-key missing"))?;
    if bytes.len() != 32 {
        return Err(SecretStoreError::Corrupt);
    }
    Ok(bytes)
}

fn decrypt_envelope(key: &[u8], raw: &[u8]) -> Result<Vec<u8>, SecretStoreError> {
    let envelope: Envelope = serde_json::from_slice(raw).map_err(|_| SecretStoreError::Corrupt)?;
    let iv = decode_hex(&envelope.iv).map_err(|_| SecretStoreError::Corrupt)?;
    let tag = decode_hex(&envelope.tag).map_err(|_| SecretStoreError::Corrupt)?;
    let mut data = STANDARD
        .decode(envelope.data.trim())
        .map_err(|_| SecretStoreError::Corrupt)?;
    if iv.len() != 12 || tag.len() != 16 {
        return Err(SecretStoreError::Corrupt);
    }
    data.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SecretStoreError::Crypto)?;
    let nonce = Nonce::from_slice(&iv);
    cipher
        .decrypt(nonce, data.as_ref())
        .map_err(|_| SecretStoreError::Crypto)
}

fn encrypt_envelope(key: &[u8], plain: &[u8]) -> Result<Envelope, SecretStoreError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SecretStoreError::Crypto)?;
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);
    let mut sealed = cipher
        .encrypt(nonce, plain)
        .map_err(|_| SecretStoreError::Crypto)?;
    if sealed.len() < 16 {
        return Err(SecretStoreError::Crypto);
    }
    let tag = sealed.split_off(sealed.len() - 16);
    Ok(Envelope {
        iv: encode_hex(&iv),
        tag: encode_hex(&tag),
        data: STANDARD.encode(&sealed),
    })
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn decode_hex(text: &str) -> Result<Vec<u8>, ()> {
    if text.len() % 2 != 0 {
        return Err(());
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let hi = hex_val(bytes[index])?;
        let lo = hex_val(bytes[index + 1])?;
        out.push((hi << 4) | lo);
        index += 2;
    }
    Ok(out)
}

fn hex_val(byte: u8) -> Result<u8, ()> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(()),
    }
}

struct MigrationLock {
    #[cfg(unix)]
    _file: File,
    #[cfg(not(unix))]
    _guard: std::sync::MutexGuard<'static, ()>,
}

fn lock_migration(dir: &Path) -> Result<MigrationLock, SecretStoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::io::AsRawFd;
        let path = dir.join(".connections-migrate.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW);
        let file = options.open(&path)?;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if rc != 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(MigrationLock { _file: file })
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        Ok(MigrationLock {
            _guard: LOCK.lock().unwrap_or_else(|err| err.into_inner()),
        })
    }
}

/// Copy an older data directory when the desktop config dir is still empty.
pub fn import_tree(dest: &Path, source: &Path) -> Result<bool, SecretStoreError> {
    secret_store::ensure_private_dir(dest)?;
    if same_dir(dest, source)? {
        return Ok(false);
    }
    let source_meta = fs::symlink_metadata(source).map_err(SecretStoreError::from)?;
    if source_meta.file_type().is_symlink() || !source_meta.is_dir() {
        return Err(SecretStoreError::RefusingSymlink);
    }
    ensure_owned(&source_meta)?;
    if dest_has_state(dest)? {
        return Ok(false);
    }
    if !source_has_state(source)? {
        return Ok(false);
    }
    let sqlite = source.join(SQLITE_NAME);
    if secret_store::regular_file_exists(&sqlite)? {
        copy_sqlite_snapshot(&sqlite, &dest.join(SQLITE_NAME))?;
    }
    for name in [PRIVATE_NAME, KEY_NAME] {
        let from = source.join(name);
        if secret_store::regular_file_exists(&from)? {
            copy_private(&from, &dest.join(name))?;
        }
    }
    let recorded = fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    secret_store::write_private_file(
        &dest.join(SOURCE_POINTER),
        recorded.to_string_lossy().as_bytes(),
    )?;
    Ok(true)
}

/// Consistent snapshot. Copying `-wal`/`-shm` beside a live writer can tear the file.
fn copy_sqlite_snapshot(from: &Path, to: &Path) -> Result<(), SecretStoreError> {
    if secret_store::regular_file_exists(to)? {
        return Err(SecretStoreError::Corrupt);
    }
    let copied = (|| {
        let src =
            rusqlite::Connection::open_with_flags(from, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(map_sqlite)?;
        src.busy_timeout(Duration::from_millis(300))
            .map_err(map_sqlite)?;
        let mut dst = rusqlite::Connection::open(to).map_err(map_sqlite)?;
        dst.busy_timeout(Duration::from_millis(300))
            .map_err(map_sqlite)?;
        {
            let backup = rusqlite::backup::Backup::new(&src, &mut dst).map_err(map_sqlite)?;
            match backup.step(-1).map_err(map_sqlite)? {
                rusqlite::backup::StepResult::Done => {}
                rusqlite::backup::StepResult::Busy | rusqlite::backup::StepResult::Locked => {
                    return Err(SecretStoreError::DatabaseBusy);
                }
                rusqlite::backup::StepResult::More => {
                    return Err(SecretStoreError::Legacy(
                        "无法复制 SQLite 沙箱：备份没有完成。".to_string(),
                    ));
                }
                _ => {
                    return Err(SecretStoreError::Legacy(
                        "无法复制 SQLite 沙箱：备份没有完成。".to_string(),
                    ));
                }
            }
        }
        let checkpointed = dst
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .is_ok();
        Ok(checkpointed)
    })();
    let checkpointed = match copied {
        Ok(done) => done,
        Err(err) => {
            let _ = fs::remove_file(to);
            return Err(err);
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(to, fs::Permissions::from_mode(0o600))?;
    }
    if checkpointed {
        if let Some(name) = to.file_name().and_then(|item| item.to_str()) {
            for suffix in ["-wal", "-shm", "-journal"] {
                let side = to.with_file_name(format!("{name}{suffix}"));
                if side != *to {
                    let _ = fs::remove_file(side);
                }
            }
        }
    }
    Ok(())
}

fn map_sqlite(err: rusqlite::Error) -> SecretStoreError {
    match &err {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::DatabaseBusy
                || code.code == rusqlite::ErrorCode::DatabaseLocked =>
        {
            SecretStoreError::DatabaseBusy
        }
        _ => SecretStoreError::Legacy(format!("无法复制 SQLite 沙箱：{err}")),
    }
}

/// After the destination vault read-back succeeds, the source ciphertext and
/// key are no longer needed. Rename them in place so a later launch does not
/// keep a second copy of the password material.
pub fn retire_legacy_secrets(dir: &Path) -> Result<Vec<PathBuf>, SecretStoreError> {
    let meta = fs::symlink_metadata(dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(SecretStoreError::RefusingSymlink);
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut renamed = Vec::new();
    for name in [PRIVATE_NAME, KEY_NAME] {
        let from = dir.join(name);
        if !secret_store::regular_file_exists(&from)? {
            continue;
        }
        let mut index = 0u32;
        let to = loop {
            let file_name = if index == 0 {
                format!("{name}.migrated-{stamp}")
            } else {
                format!("{name}.migrated-{stamp}-{index}")
            };
            let candidate = dir.join(file_name);
            match fs::symlink_metadata(&candidate) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(SecretStoreError::RefusingSymlink);
                }
                Ok(_) => {
                    index += 1;
                    if index > 20 {
                        return Err(SecretStoreError::Corrupt);
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::NotFound => break candidate,
                Err(err) => return Err(err.into()),
            }
        };
        fs::rename(&from, &to)?;
        renamed.push(to);
    }
    Ok(renamed)
}

pub fn retire_imported_source(dest: &Path) -> Result<Vec<PathBuf>, SecretStoreError> {
    let pointer = dest.join(SOURCE_POINTER);
    let Some(bytes) = secret_store::read_regular_file(&pointer)? else {
        return Ok(Vec::new());
    };
    let text = String::from_utf8(bytes).map_err(|_| SecretStoreError::Corrupt)?;
    let source = PathBuf::from(text.trim());
    if source.as_os_str().is_empty() {
        return Err(SecretStoreError::Corrupt);
    }
    if same_dir(dest, &source)? {
        let _ = fs::remove_file(&pointer);
        return Ok(Vec::new());
    }
    match fs::symlink_metadata(&source) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(SecretStoreError::RefusingSymlink),
        Ok(meta) if !meta.is_dir() => return Err(SecretStoreError::Corrupt),
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            let _ = fs::remove_file(&pointer);
            return Ok(Vec::new());
        }
        Err(err) => return Err(err.into()),
    }
    let dest_private = secret_store::regular_file_exists(&dest.join(PRIVATE_NAME))?;
    let migrated = secret_store::regular_file_exists(&dest.join(MARKER_NAME))?;
    if dest_private && !migrated {
        return Ok(Vec::new());
    }
    let retired = retire_legacy_secrets(&source)?;
    if secret_store::regular_file_exists(&pointer)? {
        fs::remove_file(&pointer)?;
    }
    Ok(retired)
}

fn dest_has_state(dir: &Path) -> Result<bool, SecretStoreError> {
    Ok(secret_store::regular_file_exists(&dir.join(SQLITE_NAME))?
        || secret_store::regular_file_exists(&dir.join(PRIVATE_NAME))?
        || secret_store::regular_file_exists(&dir.join("secrets.vault"))?)
}

fn source_has_state(dir: &Path) -> Result<bool, SecretStoreError> {
    Ok(secret_store::regular_file_exists(&dir.join(SQLITE_NAME))?
        || secret_store::regular_file_exists(&dir.join(PRIVATE_NAME))?)
}

fn same_dir(left: &Path, right: &Path) -> Result<bool, SecretStoreError> {
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    Ok(left == right)
}

fn ensure_owned(meta: &fs::Metadata) -> Result<(), SecretStoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::geteuid() };
        if meta.uid() != uid {
            return Err(SecretStoreError::NotOwner);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
    }
    Ok(())
}

fn copy_private(from: &Path, to: &Path) -> Result<(), SecretStoreError> {
    let bytes = secret_store::read_regular_file(from)?.ok_or(SecretStoreError::Corrupt)?;
    secret_store::write_private_file(to, &bytes)
}

pub fn candidate_dirs(extra: &[PathBuf]) -> Vec<PathBuf> {
    let legacy = std::env::var("TONGYUN_LEGACY_DATA_DIR").ok();
    legacy_candidates(legacy, extra)
}

fn legacy_candidates(legacy_env: Option<String>, extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(value) = legacy_env {
        if !value.is_empty() {
            out.push(PathBuf::from(value));
        }
    }
    out.extend(extra.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tongyun-db-legacy-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_legacy(dir: &Path, password: &str) {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        let key = [7u8; 32];
        secret_store::write_private_file(&dir.join(KEY_NAME), &key).unwrap();
        let records = serde_json::json!([{
            "id": "11111111-1111-4111-8111-111111111111",
            "name": "Example",
            "engine": "mysql",
            "host": "127.0.0.1",
            "port": 3306,
            "database": "example",
            "username": "test",
            "password": password,
            "environment": "test",
            "allowWrites": false,
            "tls": false
        }]);
        let plain = serde_json::to_vec(&records).unwrap();
        let envelope = encrypt_envelope(&key, &plain).unwrap();
        let bytes = serde_json::to_vec(&envelope).unwrap();
        secret_store::write_private_file(&dir.join(PRIVATE_NAME), &bytes).unwrap();
    }

    #[test]
    fn migrates_password_out_of_the_connection_blob() {
        let dir = temp_dir();
        let password = "synthetic-db-password";
        write_legacy(&dir, password);
        let report = migrate_connection_passwords(&dir).unwrap();
        assert_eq!(report.imported, 1);
        assert!(!report.already_migrated);
        let raw = fs::read(dir.join(PRIVATE_NAME)).unwrap();
        assert!(!raw
            .windows(password.len())
            .any(|window| window == password.as_bytes()));
        let store = FileSecretStore::open(StorePaths::new(&dir)).unwrap();
        assert_eq!(
            store
                .get("connection/11111111-1111-4111-8111-111111111111")
                .unwrap()
                .as_deref(),
            Some(password)
        );
        let again = migrate_connection_passwords(&dir).unwrap();
        assert!(again.already_migrated);
        let mode = fs::metadata(dir.join("secrets.vault"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        let key_mode = fs::metadata(dir.join("secret.key"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(key_mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_seed_does_not_rewrite_an_existing_vault() {
        let dir = temp_dir();
        write_legacy(&dir, "synthetic-db-password");
        let vault = dir.join("secrets.vault");
        fs::write(&vault, b"not-a-real-vault").unwrap();
        fs::set_permissions(&vault, fs::Permissions::from_mode(0o600)).unwrap();
        let err = migrate_connection_passwords(&dir).unwrap_err();
        assert!(matches!(err, SecretStoreError::MissingSeed));
        assert_eq!(fs::read(&vault).unwrap(), b"not-a-real-vault");
        assert!(!dir.join(MARKER_NAME).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn symlink_private_file_is_refused() {
        let dir = temp_dir();
        let outside = temp_dir();
        fs::write(outside.join("keep"), b"untouched").unwrap();
        std::os::unix::fs::symlink(outside.join("keep"), dir.join(PRIVATE_NAME)).unwrap();
        fs::write(dir.join(KEY_NAME), [9u8; 32]).unwrap();
        let err = migrate_connection_passwords(&dir).unwrap_err();
        assert!(matches!(err, SecretStoreError::RefusingSymlink));
        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"untouched");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn import_copies_a_consistent_sqlite_snapshot_and_retires_source_secrets() {
        let source = temp_dir();
        write_legacy(&source, "synthetic-db-password");
        let db_path = source.join(SQLITE_NAME);
        let source_conn = rusqlite::Connection::open(&db_path).unwrap();
        source_conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 INSERT INTO customers (id, name) VALUES (1, '林小满');
                 INSERT INTO customers (id, name) VALUES (2, '周明远');",
            )
            .unwrap();
        let dest = temp_dir();
        assert!(import_tree(&dest, &source).unwrap());
        assert!(!import_tree(&dest, &source).unwrap());
        assert!(!dest.join("sandbox.sqlite-wal").exists());
        assert!(!dest.join("sandbox.sqlite-shm").exists());
        drop(source_conn);
        let copied = rusqlite::Connection::open(dest.join(SQLITE_NAME)).unwrap();
        let count: i64 = copied
            .query_row("SELECT COUNT(*) FROM customers", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let mode = fs::metadata(dest.join(SQLITE_NAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        assert!(source.join(PRIVATE_NAME).exists());
        assert!(dest.join(SOURCE_POINTER).exists());
        let report = migrate_connection_passwords(&dest).unwrap();
        assert_eq!(report.imported, 1);
        let retired = retire_imported_source(&dest).unwrap();
        assert_eq!(retired.len(), 2);
        assert!(!source.join(PRIVATE_NAME).exists());
        assert!(!source.join(KEY_NAME).exists());
        assert!(retired.iter().all(|path| path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".migrated-")));
        assert!(!dest.join(SOURCE_POINTER).exists());
        assert!(dest.join(KEY_NAME).exists());
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn retire_waits_until_destination_migration_verifies() {
        let source = temp_dir();
        write_legacy(&source, "synthetic-db-password");
        let dest = temp_dir();
        assert!(import_tree(&dest, &source).unwrap());
        let held = retire_imported_source(&dest).unwrap();
        assert!(held.is_empty());
        assert!(source.join(PRIVATE_NAME).exists());
        assert!(source.join(KEY_NAME).exists());
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn a_locked_sqlite_file_is_not_copied_piecewise() {
        let source = temp_dir();
        let db_path = source.join(SQLITE_NAME);
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE t(id INTEGER PRIMARY KEY);
                 INSERT INTO t VALUES (1);",
            )
            .unwrap();
        }
        let err_log = source.join("holder.err");
        let err_file = File::create(&err_log).unwrap();
        let mut holder = std::process::Command::new("python3")
            .arg("-c")
            .arg("import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], isolation_level=None); c.execute('begin exclusive'); time.sleep(30)")
            .arg(&db_path)
            .stderr(std::process::Stdio::from(err_file))
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        if let Some(status) = holder.try_wait().unwrap() {
            panic!(
                "holder exited {status}: {}",
                fs::read_to_string(&err_log).unwrap_or_default()
            );
        }
        let probe = rusqlite::Connection::open(&db_path).unwrap();
        probe.busy_timeout(Duration::from_millis(50)).unwrap();
        let held = probe.execute_batch("BEGIN IMMEDIATE;").is_err();
        let dest = temp_dir();
        let result = if held {
            import_tree(&dest, &source)
        } else {
            Err(SecretStoreError::DatabaseBusy)
        };
        let _ = holder.kill();
        let _ = holder.wait();
        assert!(held, "the other process did not lock the database");
        let err = result.unwrap_err();
        assert!(
            matches!(err, SecretStoreError::DatabaseBusy),
            "expected busy, got {err}"
        );
        assert!(!dest.join(SQLITE_NAME).exists());
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn legacy_candidates_do_not_include_the_working_directory() {
        assert!(legacy_candidates(None, &[]).is_empty());
        assert!(legacy_candidates(Some(String::new()), &[]).is_empty());
        let explicit = PathBuf::from("/explicit/tongyun-data");
        assert_eq!(
            legacy_candidates(None, std::slice::from_ref(&explicit)),
            vec![explicit]
        );
        assert_eq!(
            legacy_candidates(Some("/opt/old-tongyun".to_string()), &[]),
            vec![PathBuf::from("/opt/old-tongyun")]
        );
        let cwd = std::env::current_dir().unwrap().join(".local");
        assert!(!legacy_candidates(None, &[]).contains(&cwd));
    }
}
