# 橦云数据库 · tongyun-database

人与 AI 共用的数据库工作台。连接树、SQL 编辑器、虚拟结果表格、变更检查器与操作时间线共用同一个执行核心。

当前交付为 **本地 Web 工作台 + Agent HTTP API**，支持 SQLite 沙箱、MySQL 和 Redis 7+ 的真实连接；CLI 当前仅适配 SQLite。首次启动只创建合成 SQLite，网络连接由用户在「新建连接」中添加。尚无 PostgreSQL / D1、桌面安装包或内置大模型聊天。原 Drizzle / SQLite / D1 模板方向保留为后续适配，不能当成已实现功能。

## 核心流程

打开表 → 主键分页查看数据 → 选择一行 → 填写修改字段 → 生成正向与回滚 SQL → 审查并确认 → 执行 → 在时间线追溯 → 必要时核对新值后回滚。

- 默认最多 1000 行，结果体最多 2 MiB，独立查询进程 2 秒超时；表浏览使用整数主键游标，不做深 OFFSET 或自动全表计数。
- 结果表格仅渲染可视区及缓冲行。任意 SQL 的结果只读；只有明确的表浏览记录可用于准备更新，避免把 JOIN / 别名结果误写回。
- 单行 UPDATE 必须有预览、旧值快照、参数化执行 SQL、参数化回滚 SQL和计划指纹；数据或结构变化会拒绝操作。
- 操作开始、成功、失败、确认和取消均进入本机审计。执行 SQL、变更快照、回滚参数存在本机私有表中，不进入 Git。
- UI 和 Agent API 使用同一数据库、计划和事件；工作台定期刷新外部 Agent 创建的计划。

## 开始使用

环境与唯一命令表见 [开发文档](docs/development.md)。当前为 Node.js 24.14+，运行依赖 mysql2、redis 和 node-sql-parser。启动后打开终端打印的本机地址，或读取 `.local/endpoint.json`。

Agent 接入协议见 [Agent API](docs/agent-api.md)，工作台内也有「查看 Agent 接入」。令牌只存 `.local/agent-token`，不打印到日志。

## MySQL 与 Redis 面板

- **MySQL**：连接和测试、基础表树与按需结构、受限只读 SELECT、主键游标分页、单行 UPDATE 的真实预览/回滚 SQL。BIGINT/DECIMAL 按字符串返回，避免丢精度。变更只支持可验证恢复的 InnoDB 表，要求单列主键、可检查触发器元数据，拒绝触发器、关联外键和不支持的列类型。
- **Redis 7+**：SCAN 模式搜索、类型/TTL/内存、String、Hash、List、Set、ZSet 的单 Key 编辑，TTL 与删除计划。回滚使用原 DUMP 快照和绝对过期时间；旧值已到期则拒绝复活。普通 Key 限 UTF-8、2 KiB 键名，编辑限制 1 MiB / 1000 元素；集群、Stream、二进制值未实现。
- **连接默认只读**。非生产连接可显式开启受控变更，生产连接禁止写入。密码 AES-256-GCM 加密落盘，密钥在本机私有目录；不能抵抗同一文件所有者读取密钥，不是系统钥匙串。

## 追溯与恢复边界

SQLite 业务更新与本机审计同事务；MySQL/Redis 与本机 SQLite 无跨库原子事务，因此先持久化执行意图，再提交远程结果。断线或审计落盘失败时保留 applying / rolling_back / unknown，阻止直接重试；原快照与恢复材料已保存。当前尚无自动核查未知结果的接口。

仅执行结构化变更计划，不支持在 SQL 查询框执行任意 INSERT/DELETE/DDL、批量改库或在 Redis 执行任意管理命令。MySQL UPDATE 预览会在事务内试算并撤销，需显式允许变更；不会自动试连本机已有业务实例。

审计拒绝普通 UPDATE/DELETE，并验证最近 200 条事件哈希链片段，可游标回溯；不具备抵抗数据库文件所有者篡改的保证。actor/task 是调用者提供的标签，不是多用户认证。用户填写真实连接前应使用服务器端最小权限账号；本次只在独立 Docker 合成数据中验证。

## 文档

- [PRD](docs/prd.md) · [架构](docs/architecture.md) · [主流程](docs/user-flows.md)
- [设计](DESIGN.md) · [验收](docs/testing/acceptance-tests.md) · [路线](docs/plan.md)

MIT。

Redis Hash 字段级 TTL 暂不支持可回滚变更；普通 Key TTL 已支持。大 Key 超过内容查看/编辑上限时，仅 SCAN 元数据可用。
