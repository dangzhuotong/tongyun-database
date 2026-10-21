#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args();
    let _argv0 = args.next();
    if args.next().as_deref() == Some("--secrets") {
        let rest: Vec<String> = args.collect();
        let code = tongyun_database_core::vault_cli::secrets_main(&rest);
        std::process::exit(code);
    }
    tongyun_database_desktop_lib::run();
}
