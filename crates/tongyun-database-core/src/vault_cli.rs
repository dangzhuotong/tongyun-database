//! Stdio CLI for the Node sidecar. Secrets travel on stdin/stdout and are not
//! written to stderr.

use crate::legacy_config::migrate_connection_passwords;
use crate::secret_store::{FileSecretStore, StorePaths};
use std::env;
use std::io::{self, Read, Write};
use std::path::PathBuf;

pub fn secrets_main(args: &[String]) -> i32 {
    match dispatch(args) {
        Ok(code) => code,
        Err(err) => {
            let _ = writeln!(io::stderr(), "tongyun-database-secrets: {err}");
            1
        }
    }
}

fn dispatch(args: &[String]) -> Result<i32, String> {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "用法：tongyun-database-secrets <get|set|delete|migrate-legacy> --dir DIR --account ACCOUNT\n\n密码只从标准输入读入、写到标准输出，不进日志。"
        );
        return Ok(0);
    }
    let command = args[0].as_str();
    let dir = flag(args, "--dir")?;
    match command {
        "migrate-legacy" => {
            let report = migrate_connection_passwords(&dir).map_err(|err| err.to_string())?;
            println!(
                "{{\"ok\":true,\"alreadyMigrated\":{},\"imported\":{},\"unchanged\":{}}}",
                report.already_migrated, report.imported, report.unchanged
            );
            Ok(0)
        }
        "get" | "set" | "delete" => {
            let account = flag_str(args, "--account")?;
            let mut store =
                FileSecretStore::open(StorePaths::new(&dir)).map_err(|err| err.to_string())?;
            match command {
                "get" => match store.get(&account).map_err(|err| err.to_string())? {
                    Some(value) => {
                        let mut out = io::stdout().lock();
                        out.write_all(value.as_bytes())
                            .map_err(|err| err.to_string())?;
                        Ok(0)
                    }
                    None => Ok(2),
                },
                "set" => {
                    let mut raw = Vec::new();
                    io::stdin()
                        .read_to_end(&mut raw)
                        .map_err(|err| err.to_string())?;
                    let secret =
                        String::from_utf8(raw).map_err(|_| "密码必须是 UTF-8".to_string())?;
                    store
                        .set(&account, &secret)
                        .map_err(|err| err.to_string())?;
                    match store.get(&account).map_err(|err| err.to_string())? {
                        Some(got) if got == secret => Ok(0),
                        _ => Err("写入后核对失败".to_string()),
                    }
                }
                "delete" => {
                    store.delete(&account).map_err(|err| err.to_string())?;
                    Ok(0)
                }
                _ => unreachable!(),
            }
        }
        other => Err(format!("未知命令 {other}")),
    }
}

fn flag(args: &[String], name: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(flag_str(args, name)?))
}

fn flag_str(args: &[String], name: &str) -> Result<String, String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("缺少 {name}"))
}

pub fn run_from_env() -> i32 {
    let args: Vec<String> = env::args().skip(1).collect();
    secrets_main(&args)
}
