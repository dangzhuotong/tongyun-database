# tongyun-database

Tongyun 系列的**数据库层约定与可复用技能**（给新 Web 仓直接复用）。

> 这不是又一个业务应用仓。这里只约定：怎么建 schema、怎么迁移、怎么在 SQLite / Cloudflare D1（及可替换的 SQL 后端）上用同一套应用代码；并沉淀成 skill / 模板，让新仓 `init` 时就能抄。

## 定位（一句话）

**Drizzle 优先的数据访问约定 + 可换 SQL 方言的迁移模板**，先覆盖本地 SQLite 与 Cloudflare D1；业务表仍归各产品仓自己。

## 非目标

- 不做手帐 / 宇宙 / 监控之类的产品功能
- 不做「统一中央数据库」或跨产品强耦合
- 不绑死某一家云；Drizzle 是候选默认，SQL 与驱动可换
- 不在本仓塞完整后端服务

## 候选技术（拍板前可改）

| 层 | 候选 | 备注 |
|----|------|------|
| ORM / query | [Drizzle ORM](https://orm.drizzle.team/) | TypeScript 友好，SQLite / D1 一等公民 |
| 本地 / 桌面旁路 | SQLite（`better-sqlite3` 或 `libsql`） | 与 Tauri / Node 开发机一致 |
| 边缘 / 免费托管 | Cloudflare D1 | 与 Pages/Workers 同生态 |
| 迁移 | Drizzle Kit | 生成 SQL，可审可回放 |
| 校验 | Zod（可选）与 Drizzle schema 对齐 | 不强制 |

若某新仓更适合 Prisma / 裸 SQL，本仓只提供**边界与目录约定**，不强行替换。

## 给新 Web 仓怎么用（规划）

1. 从本仓复制或 submodule `skills/tong-database`（名称待定）与 `templates/`。
2. 在产品仓里保留自己的 `drizzle/` / `src/db/`，schema 属于产品，不回流本仓除非是通用范例。
3. `AGENTS.md` 写明：改表先改 schema → 生成迁移 → 本地/D1 各跑一遍。

具体脚本与 skill 正文见 `docs/todo.md`，**本轮只建仓与文档，不写大功能**。

## 仓库里有什么

- `AGENTS.md`：Agent 入口与边界
- `docs/prd.md`：问题与范围
- `docs/todo.md`：待办（技能正文、模板、示例迁移…）
- `docs/architecture.md`：限界上下文（脚手架骨架，将收窄到「数据库约定」）
- 脚手架自带的 docs / `.agents` 骨架

## 状态

已公开。技能正文与 Drizzle 模板见 `docs/todo.md`，按待办推进。

## License

MIT。
