# tongyun-database 待办

只列事项，本轮不实现大功能。

## P0（过目通过后）
- [ ] 仓库改公开 + README 定稿
- [ ] 写 `skills/tong-database/SKILL.md`（何时用、schema 约定、迁移步骤、SQLite↔D1 差异）
- [ ] `templates/drizzle-sqlite/` 与 `templates/drizzle-d1/` 最小可跑示例（hello table + migrate）
- [ ] 在 `tongyun-scaffold` 的 init 文档里加一句：Web 仓可挂本仓 database skill

## P1
- [ ] 通用范例：`users` / `outbox` 是否值得进 templates（默认不进业务表）
- [ ] CI：对 templates 跑 `drizzle-kit check` / 最小 migrate
- [ ] 与 tongyun-api / verse 等现有库的对照表（各用啥、如何渐进对齐）

## 不做
- [ ] 不把各产品 schema 搬进本仓
- [ ] 不在本仓部署生产数据库
