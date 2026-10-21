fn main() {
    let code = tongyun_database_core::vault_cli::run_from_env();
    std::process::exit(code);
}
