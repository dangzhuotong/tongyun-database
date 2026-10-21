import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDatabaseMcpServer } from '../src/mcp/server.mjs';

const WRITE_TOOLS = ['create_plan', 'apply_plan', 'rollback_plan'];

async function session(t, { allowWrites, env, handler }) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined };
    requests.push(request);
    const result = handler(request);
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const mcp = createDatabaseMcpServer({
    allowWrites,
    env: env ?? {},
    baseUrl: `http://127.0.0.1:${http.address().port}`,
    token: 'test-token',
  });
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await mcp.close();
    await new Promise(resolve => http.close(resolve));
  });
  return { client, requests };
}

function expectHeaders(request) {
  assert.equal(request.headers.authorization, 'Bearer test-token');
  assert.equal(request.headers['x-tongyun-actor'], 'agent:mcp');
  assert.equal(request.headers['x-tongyun-task'], 'mcp');
  assert.equal(request.headers['x-tongyun-connection'], 'local-sqlite');
}

test('read-only MCP tools are registered unless writes are explicitly enabled', async t => {
  const closed = { allowWrites: false };
  const open = { allowWrites: true };
  const fromEnv = { env: { TONGYUN_DB_MCP_ALLOW_WRITES: '1' } };
  for (const options of [closed, open, fromEnv]) {
    const mcp = createDatabaseMcpServer({ ...options, baseUrl: 'http://127.0.0.1:9', token: 'test-token' });
    const client = new Client({ name: 'mcp-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    t.after(async () => { await client.close(); await mcp.close(); });
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['list_connections', 'capabilities', 'get_schema', 'run_query', 'cancel_query', 'browse_table', 'redis_scan', 'redis_read', 'list_plans', 'get_plan', 'get_audit']) {
      assert.ok(names.includes(name), name);
    }
    const writesOn = options.allowWrites === true || options.env?.TONGYUN_DB_MCP_ALLOW_WRITES === '1';
    for (const name of WRITE_TOOLS) assert.equal(names.includes(name), writesOn, name);
  }
});

test('each read tool calls the Agent API path and headers and returns the body', async t => {
  const cases = [
    ['list_connections', {}, 'GET', '/api/connections'],
    ['capabilities', {}, 'GET', '/api/capabilities'],
    ['get_schema', {}, 'GET', '/api/schema'],
    ['get_schema', { table: 'users' }, 'GET', '/api/schema?table=users'],
    ['run_query', { sql: 'SELECT 1' }, 'POST', '/api/query', { sql: 'SELECT 1' }],
    ['cancel_query', { queryId: '11111111-1111-4111-8111-111111111111' }, 'POST', '/api/queries/11111111-1111-4111-8111-111111111111/cancel', {}],
    ['browse_table', { table: 'users', after: '10' }, 'POST', '/api/browse', { table: 'users', after: '10' }],
    ['redis_scan', { pattern: 'a*', cursor: '0' }, 'POST', '/api/redis/scan', { pattern: 'a*', cursor: '0' }],
    ['redis_read', { key: 'user:1' }, 'POST', '/api/redis/read', { key: 'user:1' }],
    ['list_plans', {}, 'GET', '/api/plans'],
    ['get_plan', { id: 'plan-1' }, 'GET', '/api/plans/plan-1'],
    ['get_audit', { before: '20' }, 'GET', '/api/audit?before=20'],
  ];
  const { client, requests } = await session(t, {
    allowWrites: false,
    handler: request => ({ body: { ok: true, url: request.url, rows: [{ n: 1 }] } }),
  });
  for (const [name, args, method, path, body] of cases) {
    const result = await client.callTool({ name, arguments: args });
    const request = requests.at(-1);
    assert.equal(result.isError, false);
    assert.equal(request.method, method);
    assert.equal(request.url, path);
    assert.deepEqual(request.body, body);
    expectHeaders(request);
    assert.equal(JSON.parse(result.content[0].text).url, path);
  }
});

test('upstream errors pass through and write tools still require approvedDigest', async t => {
  const missing = createDatabaseMcpServer({ env: {}, allowWrites: false });
  const missingClient = new Client({ name: 'mcp-test', version: '0.0.0' });
  const [missingClientTransport, missingServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([missingClient.connect(missingClientTransport), missing.connect(missingServerTransport)]);
  t.after(async () => { await missingClient.close(); await missing.close(); });
  const missingResult = await missingClient.callTool({ name: 'list_connections', arguments: {} });
  assert.equal(missingResult.isError, true);
  assert.match(missingResult.content[0].text, /TONGYUN_DB_URL/);
  assert.equal(missingResult.content[0].text.includes('test-token'), false);

  const { client, requests } = await session(t, {
    allowWrites: true,
    handler: request => request.url === '/api/query'
      ? { status: 409, body: { ok: false, error: 'QUERY_REJECTED' } }
      : { body: { ok: true, accepted: request.body } },
  });
  const rejected = await client.callTool({ name: 'run_query', arguments: { sql: 'DELETE FROM users' } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /QUERY_REJECTED/);
  assert.equal(requests[0].url, '/api/query');
  const applied = await client.callTool({ name: 'apply_plan', arguments: { id: 'plan-9', approvedDigest: 'abc123' } });
  assert.equal(applied.isError, false);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/plans/plan-9/apply');
  assert.deepEqual(requests.at(-1).body, { approvedDigest: 'abc123' });
  const rolled = await client.callTool({ name: 'rollback_plan', arguments: { id: 'plan-9', approvedDigest: 'abc123' } });
  assert.equal(rolled.isError, false);
  assert.equal(requests.at(-1).url, '/api/plans/plan-9/rollback');
  assert.deepEqual(requests.at(-1).body, { approvedDigest: 'abc123' });
});

test('MCP responses omit plan digests so a write-enabled agent cannot copy one into apply', async t => {
  const secret = 'cafebabe'.repeat(8);
  const { client, requests } = await session(t, {
    allowWrites: true,
    handler: () => ({
      body: {
        ok: true,
        id: 'plan-1',
        digest: secret,
        plans: [{ id: 'plan-1', digest: secret, state: 'prepared' }],
        events: [{ action: 'prepare_update', digest: secret }],
      },
    }),
  });
  for (const [name, args] of [
    ['get_plan', { id: 'plan-1' }],
    ['list_plans', {}],
    ['create_plan', { changes: { name: 'Next' } }],
    ['get_audit', {}],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, name);
    assert.equal(result.content[0].text.includes(secret), false, name);
    assert.equal(result.content[0].text.includes('"digest"'), false, name);
  }
  const applied = await client.callTool({ name: 'apply_plan', arguments: { id: 'plan-1', approvedDigest: 'from-reviewer' } });
  assert.equal(applied.content[0].text.includes(secret), false);
  assert.equal(applied.content[0].text.includes('from-reviewer'), false);
  assert.deepEqual(requests.at(-1).body, { approvedDigest: 'from-reviewer' });
});
