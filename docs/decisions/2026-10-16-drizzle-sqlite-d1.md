# ADR：默认 Drizzle + SQLite / D1（候选）

- 状态：候选，待阿橦过目
- 决定倾向：新 Web 仓默认 Drizzle；本地 SQLite，边缘 Cloudflare D1；SQL 可换
- 理由：与 TS 栈一致、D1 官方友好、迁移可审
- 后果：技能与模板按 Drizzle Kit 写；若某仓选 Prisma，只遵循目录与迁移纪律，不强迁 ORM
