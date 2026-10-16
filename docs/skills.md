# 项目 skill

本项目的 agent skill 是**项目级文件**，跟代码一起提交，谁 clone 下来都能直接用。

## 目录

```text
.agents/skills/
  tong-project/  tong-product/  tong-ui-design/  tong-api/
  tong-test/     tong-code-review/  tong-deploy/      # Coding 套装（同步来的；pro 版名字带 -pro）
  <项目名>-xxx/                                        # 本项目自己的 skill
  SOURCES.md                                           # edition + 来源仓 + commit SHA
.claude/skills -> ../.agents/skills    # Claude Code
.cursor/skills -> ../.agents/skills    # Cursor（Codex 直接读 .agents/skills）
CLAUDE.md -> AGENTS.md
.agents/notes/{proposed,implemented,rejected,archived}/        # 设计记录
```

什么时候用哪个 skill，写在 [AGENTS.md](../AGENTS.md) 对应步骤里，不在这里另列一张表。

## 同步 Coding 套装

`tong-*` 复制成真实文件（不是软链），有两个版本：

- **lite**（默认）：开源 MIT 精简版 `tong-xxx`，不需要任何权限；
- **pro**：商业完整版 `tong-xxx-pro`，来自私有仓 tongyun-skills-plus，需要访问权限。

```bash
bash scripts/sync-skills.sh                   # 按 SOURCES.md 里记的版本刷新
bash scripts/sync-skills.sh --edition pro     # 切到 pro
bash scripts/sync-skills.sh --edition lite    # 切回 lite
```

- 版本顺序：`--edition` → 环境变量 `TONGYUN_SKILLS_EDITION` → `SOURCES.md` 里上次的版本 → lite。
- 来源：lite 用 `TONGYUN_SKILLS_LITE`（本地路径）→ `~/.cache/tongyun-skills-lite` → clone `TONGYUN_SKILLS_LITE_GIT`；pro 用 `TONGYUN_SKILLS_PLUS` → `~/.cache/tongyun-skills-plus` → SSH clone。
- 切换版本会删掉另一版本的 7 个目录，并把 AGENTS.md 里点名的链接改成新名字；项目自己的 skill 不受影响。
- 重跑即原地更新，并重写 `.agents/skills/SOURCES.md`；`tong-*` 的本地改动会被覆盖。
- 只写本项目 `.agents/skills/`，不碰 `~/.cursor`、`~/.codex`、`~/.workbuddy` 等全局目录。
- 更新后看一眼 `git diff .agents/skills AGENTS.md` 再提交。

## 注意

- `.agents/skills` 不能写进 `.gitignore`，它就是要提交的。
- pro 版来自私有、商业许可的 tongyun-skills-plus。**用 pro 版的项目若改成公开，这些 skill 正文也会跟着公开**；公开前先切回 lite：`bash scripts/sync-skills.sh --edition lite`。
