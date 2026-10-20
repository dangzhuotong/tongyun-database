import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true };

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function textResult(value, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createDatabaseMcpServer(options = {}) {
  const env = options.env ?? process.env;
  const allowWrites = options.allowWrites ?? env.TONGYUN_DB_MCP_ALLOW_WRITES === '1';
  const baseUrl = String(options.baseUrl ?? env.TONGYUN_DB_URL ?? '').replace(/\/$/, '');
  const token = options.token ?? env.TONGYUN_DB_TOKEN ?? '';
  const actor = options.actor || env.TONGYUN_DB_ACTOR || 'agent:mcp';
  const task = options.task || env.TONGYUN_DB_TASK || 'mcp';
  const connection = options.connection || env.TONGYUN_DB_CONNECTION || 'local-sqlite';
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const server = new McpServer({ name: 'tongyun-database', version: '0.1.1' });

  async function call(method, path, body) {
    if (!baseUrl || !token) return textResult({ ok: false, error: 'TONGYUN_DB_URL 与 TONGYUN_DB_TOKEN 都要设置' }, true);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-Tongyun-Actor': actor,
          'X-Tongyun-Task': task,
          'X-Tongyun-Connection': connection,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { data = { ok: false, error: 'INVALID_RESPONSE' }; }
      if (!response.ok || data.ok === false) return textResult({ status: response.status, ...data }, true);
      return textResult(data);
    } catch {
      return textResult({ ok: false, error: 'MCP_UPSTREAM_FAILED' }, true);
    }
  }

  server.registerTool('list_connections', {
    description: '列出工作台连接的公开元数据，不含密码。',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => call('GET', '/api/connections'));
  server.registerTool('capabilities', {
    description: '读取当前连接支持的工具与限制。',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => call('GET', '/api/capabilities'));
  server.registerTool('get_schema', {
    description: '读取 SQL 表结构。传入 table 时只取该表。',
    inputSchema: { table: z.string().optional() },
    annotations: READ_ONLY,
  }, async ({ table } = {}) => call('GET', table ? `/api/schema?table=${encodeURIComponent(table)}` : '/api/schema'));
  server.registerTool('run_query', {
    description: '执行受限只读 SELECT，最多 1000 行 / 2 MiB。',
    inputSchema: { sql: z.string(), queryId: z.string().optional() },
    annotations: READ_ONLY,
  }, async ({ sql, queryId }) => call('POST', '/api/query', defined({ sql, queryId })));
  server.registerTool('browse_table', {
    description: '按单主键游标分页读取一张表。',
    inputSchema: { table: z.string(), after: z.string().optional() },
    annotations: READ_ONLY,
  }, async ({ table, after }) => call('POST', '/api/browse', defined({ table, after })));
  server.registerTool('redis_scan', {
    description: '按模式 SCAN Redis Key，可带 queryId 以便取消。',
    inputSchema: { pattern: z.string().optional(), cursor: z.string().optional(), queryId: z.string().optional() },
    annotations: READ_ONLY,
  }, async (args = {}) => call('POST', '/api/redis/scan', defined(args)));
  server.registerTool('redis_read', {
    description: '读取一个 Redis Key 的类型、值、TTL 和内存。',
    inputSchema: { key: z.string() },
    annotations: READ_ONLY,
  }, async ({ key }) => call('POST', '/api/redis/read', { key }));
  server.registerTool('list_plans', {
    description: '列出当前连接、任务与环境的变更计划摘要。',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => call('GET', '/api/plans'));
  server.registerTool('get_plan', {
    description: '读取一份计划的私有详情、回滚材料和确认指纹。',
    inputSchema: { id: z.string() },
    annotations: READ_ONLY,
  }, async ({ id }) => call('GET', `/api/plans/${encodeURIComponent(id)}`));
  server.registerTool('get_audit', {
    description: '读取最近审计元数据。before 为更早一页的序号。',
    inputSchema: { before: z.string().optional() },
    annotations: READ_ONLY,
  }, async ({ before } = {}) => call('GET', before ? `/api/audit?before=${encodeURIComponent(before)}` : '/api/audit'));

  if (allowWrites) {
    server.registerTool('create_plan', {
      description: '创建变更计划，不会执行。仍受连接只读策略约束。',
      inputSchema: { table: z.string().optional(), key: z.unknown().optional(), changes: z.unknown() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async args => call('POST', '/api/plans', defined(args)));
    server.registerTool('apply_plan', {
      description: '用调用方提供的 approvedDigest 执行已准备的计划。',
      inputSchema: { id: z.string(), approvedDigest: z.string() },
      annotations: WRITE,
    }, async ({ id, approvedDigest }) => call('POST', `/api/plans/${encodeURIComponent(id)}/apply`, { approvedDigest }));
    server.registerTool('rollback_plan', {
      description: '用调用方提供的 approvedDigest 回滚已执行的计划。',
      inputSchema: { id: z.string(), approvedDigest: z.string() },
      annotations: WRITE,
    }, async ({ id, approvedDigest }) => call('POST', `/api/plans/${encodeURIComponent(id)}/rollback`, { approvedDigest }));
  }
  return server;
}

export async function startDatabaseMcpServer() {
  const server = createDatabaseMcpServer();
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDatabaseMcpServer().catch(() => {
    console.error('tongyun-database MCP 启动失败');
    process.exit(1);
  });
}
