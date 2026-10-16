# 验收测试

| ID | 需求 | 用例与观察点 | 结果 |
| --- | --- | --- | --- |
| AT-01a | R-01 | 本地 UI 加载连接树、表格、结构、检查器，明暗主题可读 | passed（浏览器） |
| AT-02a | R-02 | 外部 actor 创建计划，同 task 的 HTTP 列表与 UI 可读 | passed（HTTP + 浏览器） |
| AT-03a | R-03 | 成功/失败/确认/取消记录，查询原文私有读取，审计普通 UPDATE/DELETE 被拒绝 | passed（集成） |
| AT-04a | R-04 | 预览不提交业务变更；生成正反 SQL/参数，含 NULL 和引号 | passed（SQLite 集成） |
| AT-05a | R-05 | 指纹错误、旧值变化、结构变化、计划篡改、任务不符拒绝执行 | passed（集成） |
| AT-05b | R-05 | 成功审计写入失败时，业务更新及计划推进一起撤销 | passed（SQLite 故障注入） |
| AT-06a | R-06 | apply/rollback 幂等，恢复旧值，后续被修改拒绝回滚 | passed（集成 + 浏览器更新/回滚） |
| AT-07a | R-07 | SQL 拒绝写入、ATTACH、内部表、多语句、重名列；1000 行上限与连续游标页无重叠 | passed（集成） |
| AT-07b | R-07 | 大型聚合 2 秒终止，期间可查询/写审计，随后可继续查询 | passed（真实 SQLite 子进程） |
| AT-08a | R-08 | 百万行首/中/尾页使用主键索引，不自动 COUNT/OFFSET | passed（基准；非远程 SLA） |
| AT-08b | R-08 | 浏览器查询 1000 行，1440×960 时只渲染 22 个数据行 | passed（DOM 检查） |
| AT-09a | R-09 | 缺令牌 401，外部 Origin 403，HTML 能加载 | passed（HTTP 集成） |

| AT-10a | R-10 | MySQL/Redis 真实连接测试、密码加密存储及返回脱敏、生产只读 | passed（集成） |
| AT-11a | R-11 | MySQL 单库 SELECT、查询超时、BIGINT 精度、主键游标 | passed（真实 MySQL + 浏览器） |
| AT-12a | R-12 | 单行 UPDATE 预览、冲突检测、执行与实际回滚 | passed（真实 MySQL + 浏览器） |
| AT-13a | R-13 | Redis SCAN 连续分页及 COUNT 溢出、五种数据类型读取 | passed（真实 Redis + 确定性边界测试） |
| AT-14a | R-14 | Redis 五种类型变更与恢复、绝对过期时间、已过期不复活、Hash 字段 TTL 拒绝 | passed（真实 Redis；Hash 更新/回滚另有浏览器验证） |
| AT-15a | R-15 | 远程写入结果不明时阻止重试，连接/任务隔离及私有参数读取 | passed（真实 Redis 故障注入 + HTTP） |
| AT-16a | R-16 | 各百万行/Key 环境中读取 1000 条，MySQL PRIMARY 范围扫描 | passed（本机 Docker 基准，非 SLA） |

执行证据见 [SQLite 首片](runs/2026-10-16-first-slice.md) 和 [MySQL/Redis 接入](runs/2026-10-16-mysql-redis.md)。PostgreSQL/D1、桌面安装包、真实身份认证、生产变更与长期负载均未验证。
