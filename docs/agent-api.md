# Agent API · v2 本机多引擎

读取 `.local/endpoint.json` 获取 URL、`.local/agent-token` 获取会话令牌。所有 API 使用 `Authorization: Bearer <token>`；默认连接为 local-sqlite。

- `X-Tongyun-Connection: <GET /api/connections 返回的 id>` 选择连接。
- `X-Tongyun-Actor: agent:example`、`X-Tongyun-Task: local-demo` 关联操作。UI 与 Agent 使用同一连接/任务可共用计划。
- actor/task 只是追溯标签，会话令牌代表本机访问能力；没有多用户认证。连接默认只读，生产连接强制禁止变更。

| 方法 / 路径 | 输入 / 输出 |
| --- | --- |
| GET /api/connections | 所有连接公开元数据；无密码，只返回 hasPassword |
| POST /api/connections | `{engine,name,host,port,database,username,password,environment,tls,allowWrites}`；engine=mysql/redis，默认请传 allowWrites=false |
| POST /api/connections/:id/test | `{}`；验证网络和版本，不能据此声称所有 ACL/变更权限可用 |
| GET /api/capabilities | 当前连接、实际支持的工具及限制 |
| GET /api/schema | SQL 基础表树；MySQL 列元数据按表懒加载 |
| GET /api/schema?table=名称 | MySQL 指定表的列及建表 SQL |
| POST /api/query | `{sql, queryId?}`；受限只读 SELECT，最多 1000 行 / 2 MiB。queryId 为 UUID；省略时由服务端生成。响应含 `queryId` 与 `status`：`completed` 或 `cancelled` |
| POST /api/queries/:queryId/cancel | `{}`；只取消同一连接、任务、环境下正在执行的查询。未知或已结束的 id 返回 `status: not_running`，不写取消审计，也不预留这个 id。MySQL 用另一连接执行 `KILL QUERY <threadId>`，查询在 KILL 结束后才返回 `cancelled`。SQLite 中止查询进程，Redis SCAN 中断分批循环。成功取消写入 `cancel_query` 审计；查询本身的审计结果为 `cancelled` |
| GET /api/queries/:operationId | 显式读取同连接、环境、任务的私有原始 SQL/参数 |
| POST /api/browse | `{table,after?}`；单主键游标分页，after 为字符串，返回 nextCursor |
| POST /api/redis/scan | `{pattern?,cursor?,queryId?}`；默认 * / 0，COUNT=1000 提示；最多返回 1000 个 Key，nextCursor 可为不透明本机游标。queryId 与 `POST /api/queries/:queryId/cancel` 相同，取消会中断扫描循环 |
| POST /api/redis/read | `{key}`；类型、值、TTL、内存；仅支持受限大小的 UTF-8 常见类型 |
| POST /api/plans | SQL：`{table,key,changes}`；Redis：`{key,changes:{action,...}}` |
| GET /api/plans | 当前连接/任务/环境最近 100 份摘要 |
| GET /api/plans/:id | 私有前后值、正反 SQL/命令、参数、digest、state；Redis 含真实 DUMP base64 快照 |
| POST /api/plans/:id/apply | `{approvedDigest}`；检查确认、连接策略/版本、原值与结构 |
| POST /api/plans/:id/rollback | `{approvedDigest}`；核对新值；Redis 同时核对绝对过期时间 |
| POST /api/plans/:id/cancel-confirmation | `{}`；记录取消，状态不变 |
| GET /api/operations/:operationId | 网络引擎的私有请求参数，需匹配连接/任务/环境；查看动作也被记录 |
| GET /api/audit?before=序号 | 最近 200 条元数据，nextBefore 回溯，验证返回片段哈希链，不返回原值 |

## Redis 变更类型

| action | 输入 |
| --- | --- |
| set | `value: string`，修改已有 String，保留 TTL |
| hash_set | `fields: {field:string}`，设置 Hash 字段 |
| list_set | `index: number, value:string`，修改已有 List 元素 |
| set_add / set_remove | `members: string[]` |
| zset_add | `members: [{score:number,value:string}]` |
| ttl | `seconds: -1` 为永久，0 为立即到期，正数最多一年；绝对到期时间从预览时服务器时刻计算 |
| delete | 无额外参数；原 DUMP/TTL 已持久化，可通过计划恢复 |

不提供任意 Redis 命令、Lua 或管理命令入口。恢复材料包含实际二进制快照；UI 的 RESTORE 文本展示占位符，点击回滚由适配器解码真实快照执行，不是复制占位符即可运行的脚本。

## 状态与失败

SQLite：prepared → applied → rolled_back。MySQL/Redis：prepared → applying → applied → rolling_back → rolled_back；确认未生效的失败回到原状态，不确定则 unknown 或保留中间态，禁止重复执行。没有自动 reconcile 接口；需读取当前数据、对照快照核查。

同方向成功重试返回 replayed=true、affectedRows=0，表示该计划已完成，不表示当前数据从未被其他操作修改。digest 绑定计划而非身份，不是人类授权证明。

结果包含 ok；策略拒绝/冲突 409 + 稳定 error，缺令牌 401，来源拒绝 403。SQLite 大整数编码 `{"$integer":"123"}`，MySQL BIGINT/DECIMAL 返回字符串。原始 SQL 与请求参数含敏感字面量，禁止提交或打印。

连接和计划保存在本机私有目录，目标库不自动建审计表。SQLite 审计与业务同事务；网络库只有先落意图、再执行、最后记结果的保证。认证失败、连接存储初始化失败等基础设施事件尚无独立外置审计。

当前无连接编辑/删除 API、Redis Cluster、PostgreSQL/D1、桌面打包与内置模型调用。测试版本为 MySQL 8.4 与 Redis 7.4；TLS、生产 ACL、其他版本及长期负载未验证。

stdio MCP（`npm run mcp`）是这套 HTTP API 的客户端，不是另一条写库通道。默认只暴露只读工具，其中包括 `cancel_query`。`TONGYUN_DB_MCP_ALLOW_WRITES=1` 才注册计划创建、执行和回滚。执行与回滚仍要调用方另行提供 `approvedDigest`。MCP 会从工具响应里去掉 `digest`（计划详情、列表、创建结果和审计都不回传），打开写开关也不能从这些响应里抄指纹再执行。HTTP API 仍向工作台返回 digest。

Redis Hash 字段级 TTL 暂不支持可回滚变更；普通 Key TTL 已支持。大 Key 超过内容查看/编辑上限时，仅 SCAN 元数据可用。
