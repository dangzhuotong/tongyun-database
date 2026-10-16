# MySQL / Redis 接入验收 · 2026-10-16

## 环境与结果

Node v24.21.0，macOS，本项目脚本创建并检查归属的本机 Docker MySQL 8.4、Redis 7.4；仅合成数据。未连接或修改业务数据库。

`npm run check`：语法检查及 18 项测试全部通过，0 失败、0 跳过。其中 11 项覆盖原 SQLite/HTTP 流程，7 项覆盖连接管理、SQL AST、安全分页、真实 MySQL/Redis、故障注入与远程 HTTP。

核心证据：

- 连接密码加密落盘，返回元数据不含密码；生产连接无法开启写入。
- MySQL 真实 SELECT、BIGINT 精度、主键游标、2 秒查询超时、UPDATE 预览/执行/回滚及旧值冲突。
- Redis 五种类型的编辑与恢复，Key TTL 保持、删除恢复、过期原值禁止复活；Hash 字段 TTL 不支持时明确拒绝写入。
- SCAN COUNT 超额结果保存在绑定任务/连接的游标中；确定性测试核对后续页无遗漏并补足短页。SCAN 本身为弱一致性遍历。
- Redis 已执行写入但响应丢失的故障注入，计划进入 unknown；再次调用不会重复写入。
- HTTP 连接/任务绑定，计划与查询私有读取，操作参数追溯。

最初的 MySQL 超时测试使用 COUNT 聚合，执行器可优化而未触发预算；改用实际计算的多表聚合后，真实超时路径通过。未把该次失败当作产品超时功能已通过。

## 浏览器

真实页面 `http://127.0.0.1:4319/`，使用界面完成：

1. MySQL customers.id=1 的 credits 从 120.00 预览改为 150.00，确认执行后实际查询为 150.00；确认回滚后实际查询恢复 120.00。检查器展示参数化正向与回滚 SQL。
2. Redis demo:profile 的 status 从 active 改为 paused，实际读取为 paused；确认回滚后再次读取为 active。展示 Hash 编辑器、Key 类型/内存/TTL 和恢复材料。
3. MySQL 默认带分号 SELECT 正常返回三行，9007199254740993 保留完整精度。
4. 1440×960 桌面检查；390×844 窄屏检查，documentElement 的 clientWidth/scrollWidth 均为 375，无整页横向溢出。新建连接表单默认未勾选受控变更，取消后正常返回。

本机截图（私有开发产物，不入仓）：`.local/screenshots/mysql-panel.jpg`、`.local/screenshots/redis-panel.jpg`。

## 百万规模本机基准

运行 `node scripts/benchmark-remote.mjs`，每个引擎各创建 1,000,000 条合成数据，结束后清理本次唯一命名的数据；结果保存在 `.local/remote-benchmark.json`。

| 数据源 | 位置 | 单页条数 | 耗时 |
| --- | --- | --- | --- |
| MySQL | 首段 | 1000 | 98.40 ms |
| MySQL | id > 500000 | 1000 | 102.10 ms |
| MySQL | id > 999000 | 1000 | 95.41 ms |
| Redis | SCAN 第 1 页 | 1000 | 24.93 ms |
| Redis | SCAN 第 2 页 | 1000 | 15.16 ms |
| Redis | SCAN 第 3 页 | 1000 | 12.31 ms |

MySQL EXPLAIN 为 PRIMARY / range，无 OFFSET 或自动全表 COUNT。每页单次暖缓存采样，含客户端、子进程与本地审计开销，不含 HTTP/浏览器和远程网络；不是 SLA 或长期并发压测。

## 边界

生产写入禁用；MySQL 受控变更仅限可安全恢复的单主键单行 UPDATE。Redis 内容读取/变更限制 1 MiB、1000 个集合元素；不支持 Cluster、Stream、二进制内容或 Hash 字段 TTL 的变更。未知远程结果需人工核查，尚无自动对账恢复入口。连接尚不支持编辑/删除。

本机演示实例保持运行供预览，可用 `npm run services:stop` 停止本项目拥有的实例。
