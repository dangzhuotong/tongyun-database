# PRD：tongyun-database

## 问题
Tongyun 多个 Web / 全栈仓各自摸数据库：有的还没定 ORM，有的会上 D1，桌面旁路还要 SQLite。缺少一层**可复制的约定**，新仓容易各写各的。

## 目标
提供「数据库怎么放、怎么迁、怎么在 SQLite 与 D1 间复用 schema」的约定 + skill + 最小模板，让新 Web 仓初始化时有默认答案。

## 非目标
中央业务库、跨产品强一致 schema、托管生产数据、大而全的 Backend 框架。

## 成功标准（文档阶段）
- README / AGENTS / todo 能让阿橦一眼看懂「做什么、不做什么」。
- 过目通过后可公开，且不与 tongyun-api 等业务仓抢职责。
