# 路线

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 本地 UI + Agent API + SQLite 单行安全更新/回滚 + 审计 | 首批实现，验证记录见 testing |
| M1 | 多连接、MySQL 与 Redis 实际面板、共享 Agent API、受控变更与恢复 | 已实现；真实隔离服务验证 |
| M1b | 连接编辑/移除、PostgreSQL、真实身份、可取消查询、索引诊断 | 待实现 |
| M2 | 授权范围、INSERT/DELETE、批量变更、独立审计与恢复演练 | 待设计 |
| M3 | 桌面壳、MCP、与 Dev/API/Git 的任务协议打通 | 待设计 |

原 Drizzle / SQLite / D1 模板为后续复用方向，不阻断当前人机共用工作台。
