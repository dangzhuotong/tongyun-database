# 架构

状态：当前本地原型。UI / HTTP 是适配器，变更规则集中在 change-control。

```text
public/                    原生 Web 工作台、设计令牌、虚拟结果表格
apps/desktop/              Tauri 2 + Vite 窗口：嵌入工作台、设置、检查更新
crates/tongyun-database-core/
                           文件密码库、旧连接迁移、设置文件
src/server.mjs             本机 HTTP、令牌、来源校验、路由（桌面以 sidecar 启动）
src/cli.mjs                SQLite 无界面适配器，JSON 输出
src/mcp/server.mjs         stdio MCP，只走本机 HTTP
src/connections/           连接存储、网络适配器、独立执行账本与 MySQL 查询子进程
src/change-control/
  core.mjs                 计划、快照、确认、乐观并发、补偿、审计
  query-worker.mjs         只读授权器、行数/体积限制、独立查询进程
scripts/benchmark.mjs       临时百万行 SQLite 基准及 EXPLAIN
.local/                    开发时忽略提交的合成数据沙箱与本机令牌
```

## 核心不变量

计划状态：prepared → applied → rolled_back。错误不推进状态；同方向重复请求返回 replayed。回滚后重新 apply 必须新建计划。UI 取消确认只记录事件，计划仍为 prepared/applied。

执行在 BEGIN IMMEDIATE 中锁定写入，核对 schema 与整行快照，应用参数化 SQL，验证结果，并同时更新状态和写成功事件。预览在 SAVEPOINT 中试算 SQLite 类型转换后回滚，不提交业务变更。只支持单主键普通表；含触发器、生成列、关联外键的写入拒绝。

审计起始事件先持久化；业务写入和完成事件原子提交。进程在两者之间退出时保留 started，依计划状态核查。内置审计表拒绝普通更新/删除；哈希链只验证返回的最近 200 条，不构成外部不可抵赖证据。

SQL 和执行参数保存在私有 `_tongyun_queries`，前后快照与回滚参数保存在 `_tongyun_plans`，元数据在 `_tongyun_events`。这些内部表不允许经查询 API 读取，显式审查通过受控入口并留下记录。首版内部表位于目标沙箱库，尚不适合直接接生产。

## 性能与隔离

查询在 worker 中使用只读连接及 SQLite authorizer，仅放行普通表读取与有限函数；外围 LIMIT 1001 检测截断，返回最多 1000 行 / 2 MiB。2 秒超时终止查询子进程。调用方可通过 `POST /api/queries/:queryId/cancel` 中止已经登记且仍在执行的查询：SQLite 结束查询进程，MySQL 用另一连接 `KILL QUERY` 且在该命令结束后才返回 cancelled，Redis SCAN 停止后续分批。未知或已结束的 id 返回 `not_running`，不写取消审计。成功取消写入审计。无法保证任意无索引 SQL 快速完成。

表浏览采用整数主键 `WHERE pk > cursor ORDER BY pk LIMIT 1001`，不做 COUNT(*) 或深 OFFSET。UI 只渲染可视行及缓冲。schema 与写入仍在主线程执行，因此大量元数据和复杂约束的生产负载尚未验证。

## 多引擎适配

MySQL、Redis 的计划和追溯使用本地 SQLite 独立账本，目标库不自动创建元数据表。网络结果无法与本机审计同事务；先保存 applying / rolling_back 和确认事件，后执行远程命令，最后登记结果。任何不明确结果进入 unknown 或保留中间态，禁止重试。具体保证见 ADR 0003。

MySQL 查询和分页在独立进程中解析、获取、限制结果；SQL SELECT 经 AST 白名单规范化、只读事务和服务端 max_execution_time 约束。主键分页无需深 OFFSET，结构按表懒加载。MySQL 连接超时 5 秒、查询 2 秒、读取子进程总预算 8 秒。变更预读行体积上限 64 KiB。

Redis 使用 COUNT=1000 的 SCAN 提示，超过页面的结果存在绑定连接/任务/模式的短期本机游标中，不直接截掉；COUNT 不是硬上限，SCAN 不提供快照一致性。结果最多 1000 个 Key / 2 MiB，短页在 5 秒总预算内最多补两批，避免溢出游标导致只展示少量记录。

当前网络并发上限 4。所有连接默认只读，actor/task 仍是标签；服务仅绑定本机且使用会话令牌。网络驱动不提供多用户/多租户权限体系。Drizzle/D1 与其他业务 ORM 仍未决定。

本地沙箱启用 WAL，使耗时只读查询不阻塞审计写入。单个服务进程最多并行 4 个查询进程，超过返回 QUERY_BUSY。
