# 开发与命令

环境：Node.js >= 24（`.nvmrc` 为 24；`package.json` 的 `engines.node` 为 `>=24.14.0`，使用内置 node:sqlite）。依赖 mysql2（MIT）、redis（MIT）、node-sql-parser（Apache-2.0）。命令在仓库根执行。

| 目的 | 命令 | 成功条件 |
| --- | --- | --- |
| 依赖与锁文件 | `npm install --ignore-scripts` | 安装锁文件指定的依赖 |
| 启动工作台 | `npm start` | 打印本地地址，默认 127.0.0.1:4319；可用 TONGYUN_DATABASE_PORT 改端口 |
| 全部检查 | `npm run check` | 语法与真实 SQLite / HTTP 集成测试通过 |
| 测试 | `npm test` | 只运行 `test/**/*.test.mjs`；临时合成数据库用例通过并清理。不扫描 `.claude/`、`docs/`、`node_modules` |
| CLI 用法 | `npm run db -- --help` | 输出参数说明 |
| 百万行性能 | `node scripts/benchmark.mjs` | 临时生成 100 万行，输出三段分页耗时与索引执行计划后清理 |

改代码后服务端需重启，浏览器需刷新。默认只自动创建 `.local/sandbox.sqlite` 合成数据；网络连接由 UI 添加，不读取其他项目配置或凭据。`.local/agent-token` 每次启动轮换，权限 0600；目录 0700。

使用 tongyun-dev 时先 list，再登记并启动本项目；该工具会检查 node_modules，即使当前零依赖也需要存在空目录。项目真实路径只登记在本机配置，不写入示例。

CLI 的 context 文件包含 actor/taskId/connectionId/environment，prepare 的 input 文件包含 table/key/changes。inspect 会输出私有原值与 SQL 参数，仅在受控本机查看，禁止提交输出。HTTP 接入见 [Agent API](agent-api.md)。

没有桌面打包、云端部署或生产迁移命令。

## 隔离网络数据库验证

| 目的 | 命令 | 范围 |
| --- | --- | --- |
| 启动合成服务 | `npm run services:start` | 需要已运行的 Docker；创建带所有权标签的 MySQL 8.4 / Redis 7.4，随机本机端口 |
| 停止并删除测试容器 | `npm run services:stop` | 只删除 fixture 文件记录且所有权匹配的容器，不操作其他实例 |
| 真实连接回归 | `node --test test/connections.test.mjs` | fixture 存在则运行真实 MySQL/Redis；不存在会明确 skip，不能报告为真实连接通过 |
| 网络引擎百万基准 | `node scripts/benchmark-remote.mjs` | 独立实例各造百万行/Key，按随机表/前缀清理，仅记录本机样本 |

合成测试凭据只在被忽略的 `.local/services.private.json`；真实连接密码在 connections.private.json 内加密，connection-key 权限 0600。密钥与密文同机，不宣称系统钥匙串或对文件所有者保密。不要把私有文件或请求/快照复制进仓库。

本次预览保留两个隔离演示服务，用户可在 UI 选择 MySQL/Redis。停止测试服务后演示连接仍保留，但应显示连接失败，不自动切换或启动其他数据库。
