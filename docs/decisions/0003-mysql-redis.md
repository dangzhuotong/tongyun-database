# 0003 · MySQL / Redis 与共享执行账本

状态：已实施。日期：2026-10-16。

## 决定

用户要求两种引擎都接入 UI 和 AI 交互。沿用现有 Node/Web 工作台，增加 mysql2、redis 与 node-sql-parser 驱动/解析依赖；协议以 X-Tongyun-Connection 选择引擎。CLI 仍只支持 SQLite。

连接密码使用 AES-256-GCM 加密，密钥与密文仅存在被忽略的本机目录（0700 / 0600）；公开 API 不返回密码。此设计防止意外日志/文件明文曝光，不能抵抗拥有目录读取权的同用户程序；系统钥匙串为后续项。连接默认只读，非生产可显式允许受控变更，生产写入拒绝。真实数据库账号仍需服务器端权限约束。

## MySQL

查询先解析为单条 SELECT AST，限制目标基础表、库、函数、INTO、锁定语句与变量，重新生成 SQL，不执行原始注释或尾部。查询使用只读事务、服务端 max_execution_time、最多 1000 行/2 MiB；客户端读取在子进程中执行，避免大包解析阻塞界面服务。

变更限单列主键 InnoDB，事务内锁定目标行、核对结构/旧值，参数化执行，再核对结果。预览在事务内试算真实类型转换并 rollback。拒绝触发器、关联外键、生成/自动更新及不支持的列；要求 TRIGGER 元数据可见，不能以查不到触发器就推断不存在。行快照先在服务器核对体积，最多 64 KiB。

## Redis

只提供固定操作，无任意命令/Lua入口。SCAN COUNT=1000 不是硬页大小，多余记录保存至绑定任务/连接/模式的短期游标，避免截掉记录。读取/编辑限常见五类型、UTF-8、1 MiB 与 1000 元素；大 Key 可浏览类型/TTL/内存，完整内容/编辑暂不支持。

每份变更保存 DUMP 和原绝对过期时间。受控 Lua 内比较当前二进制值和过期时间后，仅调用一个允许的变更命令，返回实际后快照。回滚比较后快照并 RESTORE 原 DUMP，保留原绝对过期时间；已到期则拒绝复活。Lua 只提供隔离，并不提供任意多命令失败回滚，因此不接受任意命令批次。

## 跨数据库一致性

不选择向用户业务库自动创建元数据表，也不假装存在跨 SQLite/MySQL/Redis 的原子事务。选择本机持久执行意图：确认与 applying/rolling_back 先提交，再发远程命令，最后持久结果。断网、远程提交响应丢失、本机结果落盘失败均可能结果不明，禁止自动重试。未知结果自动核查尚未实现。

恢复是补偿操作，必须再确认，且只在当前值与预期一致时进行。比较当前状态不能检测改回相同值的全部外部历史（ABA），也不能恢复数据库外部副作用，因此拒绝已知不可靠的结构。

## 验证与来源

真实隔离 MySQL 8.4 / Redis 7.4 集成、HTTP、浏览器和百万规模基准见 testing 记录；无生产访问或生产数据。

- [mysql2 连接与精度选项](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-connection)
- [Redis SCAN](https://redis.io/docs/latest/commands/scan/)：COUNT 为提示与遍历一致性。
- [Redis RESTORE](https://redis.io/docs/latest/commands/restore/)：DUMP 恢复与 ABSTTL。

Redis Hash 字段级 TTL 暂不支持可回滚变更；普通 Key TTL 已支持。大 Key 超过内容查看/编辑上限时，仅 SCAN 元数据可用。
