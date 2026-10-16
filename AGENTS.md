# tongyun-database · AI 开发规则

## 当前定位

人与 AI 共用的数据库工作台，原数据库模板仓方向已扩展，依据见 [ADR 0002](docs/decisions/0002-shared-workbench.md)。已实现 Node.js 本地服务、原生 Web 界面、SQLite/MySQL/Redis 适配器、安全变更核心、SQLite CLI 和 Agent HTTP API；没有桌面壳或内置 LLM。

## 修改入口

| 任务 | 先读 |
| --- | --- |
| 行为与范围 | [PRD](docs/prd.md)、[主流程](docs/user-flows.md) |
| 模块与数据安全 | [架构](docs/architecture.md)、[ADR 0002](docs/decisions/0002-shared-workbench.md) |
| 界面 | [DESIGN.md](DESIGN.md)、[界面守则](docs/design/ui-guard.md) |
| Agent 接入 | [Agent API](docs/agent-api.md) |
| 命令与验证 | [开发文档](docs/development.md)、[验收](docs/testing/acceptance-tests.md) |
| 配套技能现状 | [skills](docs/skills.md) |

## 不变量

1. 人与 Agent 共享执行入口；不得为 AI 增设绕过检查的写入通道。
2. 每项数据变更必须有真实旧值、预览、正向和回滚 SQL（Redis 为恢复命令及 DUMP 快照）、参数、绑定目标和确认指纹。无可靠回滚则拒绝执行。
3. SQLite 在事务中核对并原子写审计；MySQL 使用事务/行锁核对，Redis 用受控单命令 Lua 核对值与过期时间。远程操作必须先持久化意图，结果不明则阻止重试，不能宣称跨数据库原子提交。
4. 开始与失败也记录；审计不可用时不执行业务变更。中断只显示 started 时需核查计划状态，禁止盲目重试。
5. 真实凭据、客户数据、数据库与私有计划不进仓、不打印。测试只用合成数据及本项目拥有的隔离实例，不读取已有业务凭据；生产连接仅允许显式配置后的只读操作。
6. 默认最多 1000 行；查询不能在 HTTP 主线程中运行。不能为了性能跳过追溯或回滚保护。
7. 修改协议、输出或状态时同步 UI、CLI、Agent 文档与行为测试。

技能按宿主实际可用入口发现；当前仓库未携带 `.agents/skills/`，不要把脚手架链接当成已安装技能。无需为开发初始化商业技能到公开仓。

提交、推送、部署仅在用户要求时执行；交接分别报告代码测试、浏览器验证与性能测试的实际范围。

网络适配器与连接管理在 `src/connections/`，数据安全决定见 [ADR 0003](docs/decisions/0003-mysql-redis.md)。连接修改、授权、未知结果恢复、TLS/ACL 行为的变化均需相应用例；不能通过简化校验让不支持的数据变得可写。
