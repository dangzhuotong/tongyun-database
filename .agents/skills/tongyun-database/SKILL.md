---
name: tongyun-database
description: |
  人与 AI 共用的数据库工作台技能。当 Agent 需要操作本仓库（启动服务、连接数据库、执行变更计划、调用 Agent API、运行测试或使用 CLI）时使用本技能。
---

# tongyun-database 技能

## 用途

本技能描述 tongyun-database 工作台的实际入口，包含：启动方法、数据库连接方式（读取哪些环境变量）、常用命令、CLI 操作流程和 Agent HTTP API 要点。所有描述以仓库根的 `README.md`、`AGENTS.md`、`docs/development.md`、`docs/agent-api.md` 及 `src/cli.mjs` 的实际行为为准。

## 启动工作台

```bash
# 安装依赖（首次或 package-lock.json 变更后）
npm install --ignore-scripts

# 启动本地 Web 工作台（默认监听 127.0.0.1:4319）
npm start
```

启动成功后终端打印本机地址，也可读取 `.local/endpoint.json` 获取 URL。每次启动会轮换 `.local/agent-token`（权限 0600）。

### 可选：隔离合成服务（MySQL / Redis，需要 Docker）

```bash
npm run services:start   # 创建带所有权标签的 MySQL 8.4 / Redis 7.4，随机本机端口
npm run services:stop    # 仅删除本项目所有的容器，不影响其他实例
```

## 连库方式（环境变量）

工作台默认只创建 `.local/sandbox.sqlite` 合成数据库，无需额外配置即可启动。

### 端口

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TONGYUN_DATABASE_PORT` | `4319` | Web 工作台监听端口 |

网络连接（MySQL / Redis）由用户在 UI「新建连接」中填写，或通过 `POST /api/connections` 写入。工作台不读取当前机器上已有的业务凭据。

> **凭据安全**：密码 AES-256-GCM 加密落盘，密钥在 `.local/` 私有目录（0700）。真实口令、`.env` 文件与私有 fixture 不得进仓库。测试服务的合成凭据在被 git 忽略的 `.local/services.private.json`。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 启动工作台 | `npm start` |
| 全部检查（语法 + 集成） | `npm run check` |
| 运行测试 | `npm test` |
| SQLite CLI | `npm run db -- --help` |
| 启动合成网络服务 | `npm run services:start` |
| 停止合成网络服务 | `npm run services:stop` |
| 百万行性能基准 | `node scripts/benchmark.mjs` |
| 网络引擎基准 | `node scripts/benchmark-remote.mjs` |
| 真实连接回归（需 fixture） | `node --test test/connections.test.mjs` |

## SQLite CLI 操作流程

CLI 仅适配本地 SQLite 文件，MySQL / Redis 变更通过工作台 API。

```bash
# 查看帮助
npm run db -- --help

# 准备变更计划（需要 context.json 与 input.json）
npm run db -- prepare --db FILE --context context.json --input input.json

# 查看计划私有原值与 SQL（仅限受控本机，禁止提交输出）
npm run db -- inspect --db FILE --context context.json --plan <PLAN_ID>

# 应用计划（需确认 digest）
npm run db -- apply --db FILE --context context.json --plan <PLAN_ID> --approve <DIGEST>

# 回滚计划
npm run db -- rollback --db FILE --context context.json --plan <PLAN_ID> --approve <DIGEST>

# 查看审计（元数据，验证哈希链）
npm run db -- audit --db FILE --context context.json
```

**context.json** 结构：`{"actor":"agent:example","taskId":"task-1","connectionId":"local-sqlite","environment":"local"}`  
**input.json** 结构：`{"table":"表名","key":{"列名":值},"changes":{"列名":新值}}`

## Agent HTTP API 要点

读取 `.local/endpoint.json` 获取 URL，`.local/agent-token` 获取令牌（每次启动轮换）。

```
Authorization: Bearer <token>
X-Tongyun-Connection: <连接 id>   # 选择连接，默认 local-sqlite
X-Tongyun-Actor: agent:example
X-Tongyun-Task: task-id
```

### 核心端点

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/connections` | 列出所有连接（不含密码） |
| `POST /api/connections` | 新增 MySQL / Redis 连接 |
| `GET /api/capabilities` | 当前连接支持的工具与限制 |
| `GET /api/schema` | 表树；`?table=名称` 获取列元数据 |
| `POST /api/query` | 受限只读 SELECT，最多 1000 行 / 2 MiB |
| `POST /api/browse` | 主键游标分页 |
| `POST /api/redis/scan` | SCAN，最多 1000 Key |
| `POST /api/redis/read` | 读单 Key 类型、值、TTL |
| `POST /api/plans` | 创建变更计划 |
| `GET /api/plans/:id` | 查看计划私有详情（含 digest） |
| `POST /api/plans/:id/apply` | 确认执行（需 approvedDigest） |
| `POST /api/plans/:id/rollback` | 确认回滚（需 approvedDigest） |
| `GET /api/audit` | 最近 200 条元数据，验证哈希链片段 |

### 变更安全约束（不变量）

1. 每项变更必须有旧值快照、预览、正向和回滚 SQL/命令、参数及确认指纹（digest）。无可靠回滚则拒绝。
2. 连接默认只读；生产连接（`environment=production`）强制禁止写入。
3. 计划状态流：SQLite `prepared → applied → rolled_back`；MySQL/Redis `prepared → applying → applied → rolling_back → rolled_back`。中间态（`unknown` / `applying`）时禁止盲目重试。
4. 审计不可用时不执行业务变更；开始与失败均记录。
5. 不支持任意 SQL INSERT/DELETE/DDL、批量改库或任意 Redis 管理命令。

## 参考文档

- [README.md](../../../README.md) — 功能概览与核心限制
- [AGENTS.md](../../../AGENTS.md) — AI 开发不变量与修改入口表
- [docs/development.md](../../../docs/development.md) — 命令速查表
- [docs/agent-api.md](../../../docs/agent-api.md) — HTTP API 完整协议
- [docs/architecture.md](../../../docs/architecture.md) — 模块与数据安全
- [docs/agent-api.md](../../../docs/agent-api.md) — Redis 变更类型详情
