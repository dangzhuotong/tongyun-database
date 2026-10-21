# 0004 桌面壳用 Tauri，数据库执行留在 Node

状态：已实施

## 问题

工作台需要和 tongyun-dev、tongyun-git 一样的桌面形态：Cargo workspace、Vite/TypeScript 前端、macOS 通用包、Tauri 更新器。已有的变更控制、MySQL/Redis 适配器和 MCP 都在 Node 里，并且有对应测试。数据库密码不能进 macOS 钥匙串。

## 决定

- 桌面窗口是 `apps/desktop` 的 Tauri 2 壳。它启动现有的 `src/server.mjs`，用 iframe 打开同一个工作台页面。
- CLI（`src/cli.mjs`）和 MCP（`src/mcp/server.mjs`）继续是 Node 进程，不另写一套写入路径。
- 数据库密码使用从 tongyun-dev `cursor/file-secret-store-1625` 复制的 `secret_store`：XChaCha20-Poly1305、本地 `secret.key`、目录 0700、文件 0600、`O_NOFOLLOW`、`create_new`、文件锁。已有 vault 但缺少 seed 时拒绝重新生成密钥。
- 不依赖 `keyring`、Stronghold 或 Security.framework 的密码 API。设置保存只写 `settings.json`。
- 旧的 `connections.private.json`（AES-256-GCM）在启动时把密码迁进 vault，再从连接文件里去掉密码。macOS 数据目录仍是 `~/Library/Application Support/tongyun-database`。
- 安装包和 `latest.json` 由标签 `v*` 的 release workflow 发布。更新器公钥在 `tauri.conf.json`，私钥只放 GitHub secret。

## 考虑过的方案

把 mysql2、Redis、SQL 解析和变更控制改写成 Rust。那样桌面可以不带 Node，但会重写已经测过的安全边界，CLI 和 MCP 也要再接一次。当前选择把执行留在原来的进程里。

继续用浏览器启动器打包 `.app`。它打不开应用内更新，也和另外两个仓库的桌面结构不一致。

## 后果与验证

打包后的应用需要本机 Node.js 24。密码命令可以是独立的 `tongyun-database-secrets`，打包后的窗口程序也接受 `--secrets`，这样安装包不必再塞一个二进制。

`cargo test -p tongyun-database-core` 覆盖密码库、迁移和“连续保存设置不创建 vault”。Node 集成测试在编译出密码命令后核对往返，并确认密文里没有明文密码。
