# 橦云数据库 · tongyun-database

人与 AI 共用的数据库工作台。连接树、SQL 编辑器、虚拟结果表格、变更检查器与操作时间线共用同一个执行核心。

当前交付为 **Tauri 桌面壳 + 本地 Web 工作台 + Agent HTTP API**，支持 SQLite 沙箱、MySQL 和 Redis 7+ 的真实连接；CLI 当前仅适配 SQLite。首次启动只创建合成 SQLite，网络连接由用户在「新建连接」中添加。尚无 PostgreSQL / D1 或内置大模型聊天。原 Drizzle / SQLite / D1 模板方向保留为后续适配，不能当成已实现功能。

## 核心流程

打开表 → 主键分页查看数据 → 选择一行 → 填写修改字段 → 生成正向与回滚 SQL → 审查并确认 → 执行 → 在时间线追溯 → 必要时核对新值后回滚。

- 默认最多 1000 行，结果体最多 2 MiB，独立查询进程 2 秒超时；表浏览使用整数主键游标，不做深 OFFSET 或自动全表计数。
- 结果表格仅渲染可视区及缓冲行。任意 SQL 的结果只读；只有明确的表浏览记录可用于准备更新，避免把 JOIN / 别名结果误写回。
- 单行 UPDATE 必须有预览、旧值快照、参数化执行 SQL、参数化回滚 SQL和计划指纹；数据或结构变化会拒绝操作。
- 操作开始、成功、失败、确认和取消均进入本机审计。执行 SQL、变更快照、回滚参数存在本机私有表中，不进入 Git。
- UI 和 Agent API 使用同一数据库、计划和事件；工作台定期刷新外部 Agent 创建的计划。

## Mac 安装

1. 前往 [Releases](../../releases) 页面，下载最新的 macOS 包：v0.1.1 为 `tongyun-database-mac.zip`，之后由 `release.yml` 构建的版本为 `*_universal.dmg`。
2. 打开镜像或解压压缩包，把其中的 **tongyun-database.app**（v0.1.1 为 **橦云数据库.app**）拖入 `/Applications`。
3. **首次打开**：因应用尚未公证，需**右键（或按住 Control 单击）→ 打开**，在弹出对话框中确认。之后可直接双击启动。
4. 窗口里就是数据工作台。数据文件仍在 `~/Library/Application Support/tongyun-database/`。已有的连接会在第一次启动时迁入加密密码文件，保存设置不会弹出钥匙串密码。从别的目录导入时，旧目录里的连接密钥会被删除，只留下无法单独解密的密文。

> **前置要求**：本机需安装 **Node.js >= 24.14**（仓库 `engines` 与 `.nvmrc` 均为 24.14.0；[nodejs.org](https://nodejs.org)）。从访达打开时 PATH 很短，桌面壳会查找 Homebrew、Volta、fnm、nvm、asdf 和登录 shell；仍找不到时窗口会说明，也可以把 `TONGYUN_NODE` 设为 node 的绝对路径。开发时也可以继续 `npm start`，用浏览器打开终端里的地址。

## 开始使用

环境与唯一命令表见 [开发文档](docs/development.md)。需要 **Node.js >= 24**（`engines` 为 >=24.14.0），运行依赖 mysql2、redis 和 node-sql-parser。`npm test` 只运行 `test/` 下的测试。启动后打开终端打印的本机地址，或读取 `.local/endpoint.json`。

Agent 接入协议见 [Agent API](docs/agent-api.md)，工作台内也有「查看 Agent 接入」。令牌只存 `.local/agent-token`，不打印到日志。

## MCP

`npm run mcp` 启动 stdio MCP 服务，只通过本机 Agent HTTP API 工作，不直接连接数据库。默认只注册只读工具，其中 `cancel_query` 用来取消带 `queryId` 的查询。写工具 `create_plan`、`apply_plan`、`rollback_plan` 仅在 `TONGYUN_DB_MCP_ALLOW_WRITES=1` 时注册；执行和回滚仍然要带审阅者提供的 `approvedDigest`。MCP 响应不含 `digest`。

地址和令牌放在环境变量里，不要写进仓库。`X-Tongyun-Actor` 默认 `agent:mcp`。

Cursor 或 Claude Desktop 可这样配置（把路径和令牌换成你本机的）：

```json
{
  "mcpServers": {
    "tongyun-database": {
      "command": "node",
      "args": ["/绝对路径/tongyun-database/src/mcp/server.mjs"],
      "env": {
        "TONGYUN_DB_URL": "http://127.0.0.1:4319",
        "TONGYUN_DB_TOKEN": "<.local/agent-token 的内容>",
        "TONGYUN_DB_CONNECTION": "local-sqlite",
        "TONGYUN_DB_TASK": "mcp"
      }
    }
  }
}
```

需要写工具时，在 `env` 里加上 `"TONGYUN_DB_MCP_ALLOW_WRITES": "1"`。生产连接本身仍禁止写入。

## MySQL 与 Redis 面板

- **MySQL**：连接和测试、基础表树与按需结构、受限只读 SELECT、主键游标分页、单行 UPDATE 的真实预览/回滚 SQL。BIGINT/DECIMAL 按字符串返回，避免丢精度。变更只支持可验证恢复的 InnoDB 表，要求单列主键、可检查触发器元数据，拒绝触发器、关联外键和不支持的列类型。
- **Redis 7+**：SCAN 模式搜索、类型/TTL/内存、String、Hash、List、Set、ZSet 的单 Key 编辑，TTL 与删除计划。回滚使用原 DUMP 快照和绝对过期时间；旧值已到期则拒绝复活。普通 Key 限 UTF-8、2 KiB 键名，编辑限制 1 MiB / 1000 元素；集群、Stream、二进制值未实现。
- **连接默认只读**。非生产连接可显式开启受控变更，生产连接禁止写入。密码在本机 `secrets.vault`（目录 0700，文件 0600），密钥是同目录的 `secret.key`；不能抵抗同一文件所有者读取密钥，不使用系统钥匙串。没有密码命令时，开发用的 `npm start` 仍把整份连接记录放在 AES-256-GCM 文件里。

## 追溯与恢复边界

SQLite 业务更新与本机审计同事务；MySQL/Redis 与本机 SQLite 无跨库原子事务，因此先持久化执行意图，再提交远程结果。断线或审计落盘失败时保留 applying / rolling_back / unknown，阻止直接重试；原快照与恢复材料已保存。当前尚无自动核查未知结果的接口。

仅执行结构化变更计划，不支持在 SQL 查询框执行任意 INSERT/DELETE/DDL、批量改库或在 Redis 执行任意管理命令。MySQL UPDATE 预览会在事务内试算并撤销，需显式允许变更；不会自动试连本机已有业务实例。

审计拒绝普通 UPDATE/DELETE，并验证最近 200 条事件哈希链片段，可游标回溯；不具备抵抗数据库文件所有者篡改的保证。actor/task 是调用者提供的标签，不是多用户认证。用户填写真实连接前应使用服务器端最小权限账号；本次只在独立 Docker 合成数据中验证。

## 模板选型与仓库边界（候选）

原 Drizzle / SQLite / D1 模板方向仍是后续候选，见 [候选 ADR](docs/decisions/2026-10-16-drizzle-sqlite-d1.md) 与 [路线](docs/plan.md)。本仓当前没有 `templates/` 运行时，也没有迁移任何产品 schema；下面对比仅说明方向，不代表已实现或已选定。

- **Drizzle + 本地 SQLite**：单机、离线或需要直接文件访问的本地开发与原型；迁移可审、无需云服务，但并发与多副本能力有限。
- **Drizzle + Cloudflare D1**：部署在 Cloudflare 边缘、需要托管 SQLite 的 Web 应用；默认受 D1 的语句/结果大小、单线程写与最终一致语义约束。
- 两者共享 Drizzle schema 与迁移纪律；实际业务 ORM 以目标仓现有栈为准，不因本候选强行迁移。

## 不要放进本仓

- 真实凭据、令牌、`.env`、私钥，以及数据库/业务连接信息（含生产或客户实例）。
- 客户数据、生产备份、真实快照或任何可识别的个人数据；测试只用合成数据。
- 产品业务 schema 与迁移、生产元数据表结构定义。
- 私有计划、内部审计导出与未公开路线细节；内部 `_tongyun_*` 表只存在于运行时沙箱。
- 内置大模型或商业技能正文；技能按宿主实际入口发现，不复制进公开仓。

## 文档

- [PRD](docs/prd.md) · [架构](docs/architecture.md) · [主流程](docs/user-flows.md)
- [设计](DESIGN.md) · [验收](docs/testing/acceptance-tests.md) · [路线](docs/plan.md)

MIT。

Redis Hash 字段级 TTL 暂不支持可回滚变更；普通 Key TTL 已支持。大 Key 超过内容查看/编辑上限时，仅 SCAN 元数据可用。
