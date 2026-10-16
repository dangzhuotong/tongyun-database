# tongyun-database · AI 开发规则

所有在本仓库工作的 agent 先读本文件（`CLAUDE.md` 是它的软链）。细节链接到各自唯一维护的文档，不要在多处复制命令表。

## 项目与修改入口

- 用途：Tongyun 系列数据库层约定与可复用技能（Drizzle + SQLite/D1 候选，SQL 可换），给新 Web 仓复用
- 技术栈：未建立（初始化后由人补齐；不要假装已有脚手架）
- 轻量 DDD：限界上下文与目录见 [docs/architecture.md](docs/architecture.md)。跨上下文不要直接改对方的持久化或内部类型。

| 要改什么 | 先读 |
| --- | --- |
| 需求、验收 | [docs/prd.md](docs/prd.md) |
| 排期 | [docs/plan.md](docs/plan.md) |
| 模块边界 | [docs/architecture.md](docs/architecture.md) |
| 命令、CI | [docs/development.md](docs/development.md) |
| 主流程 | [docs/user-flows.md](docs/user-flows.md) |
| 界面改动 | [DESIGN.md](DESIGN.md) 定值，[docs/design/ui-guard.md](docs/design/ui-guard.md) 自查 |
| 测试 | [docs/testing/acceptance-tests.md](docs/testing/acceptance-tests.md) |
| 长期决定 | [docs/decisions/](docs/decisions/)；设计取舍记 [.agents/notes/](.agents/notes/README.md) |

项目 skill 都在 `.agents/skills/`（随仓库提交，`.claude/skills`、`.cursor/skills` 指向同一份）。用到哪个，先读它的 `SKILL.md` 再动手。当前用的是开源 lite 版还是商业 pro 版，看 `.agents/skills/SOURCES.md`；切版本用 `scripts/sync-skills.sh --edition`，下面的链接会跟着改。

## 开发流程

1. **改规则 / 文档结构 / 加工种**：按 [tong-project](.agents/skills/tong-project/SKILL.md) 改本文件和 `docs/`。
2. **需求、验收**：按 [tong-product](.agents/skills/tong-product/SKILL.md) 写进 [docs/prd.md](docs/prd.md)，保留 R-xx / AT-xx 编号。
3. **实现**：
   - Web 界面按 [tong-ui-design](.agents/skills/tong-ui-design/SKILL.md)；
   - 后端接口、数据、迁移按 [tong-api](.agents/skills/tong-api/SKILL.md)。
   改动前读受影响上下文的规则和实现，写清目标行为与验收方式。
4. **推送前**：按 [tong-test](.agents/skills/tong-test/SKILL.md) 跑验收并如实记录结果，再按 [tong-code-review](.agents/skills/tong-code-review/SKILL.md) 审一遍 diff。只报实际跑过的命令。
5. **部署**：只在用户明确授权范围内，按 [tong-deploy](.agents/skills/tong-deploy/SKILL.md) 执行，留健康证据和回滚说明。

命令表只在 [docs/development.md](docs/development.md) 维护。未建立的入口标「未建立」，**不要声称跑过不存在的命令**。

## 项目自己的 skill

本项目特有的做法（例如 `tongyun-database-pre-push-checks`）写成 `.agents/skills/<项目名>-xxx/SKILL.md`，和 tong-* 放在一起，并在上面对应步骤里点名。`tong-*` 由 `scripts/sync-skills.sh` 管理，别直接改（重同步会覆盖），来源见 `.agents/skills/SOURCES.md`。

## 修改约束

- 沿用现有技术栈与目录；保护工作区已有改动。
- 密钥、Token、客户数据：**不进仓、不打印**。

## 完成交接

说明改了什么、实际跑了哪些检查、失败/跳过/未运行、缺口与下一步。提交 / 推送 / 发版仅在用户明确要求时做。
