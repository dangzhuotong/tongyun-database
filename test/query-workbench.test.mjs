import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChangeControl } from '../src/change-control/core.mjs';
import { createWorkbench } from '../src/server.mjs';
import { withMysqlCancel } from '../src/connections/mysql-cancel.mjs';
import { mapInChunks } from '../src/connections/redis-scan.mjs';
import { resetQueries } from '../src/queries/registry.mjs';
import { applyResultView, columnKind, filterRows, sortRows } from '../public/result-table.js';

const context = { actor: 'agent:test', taskId: 'task-1', connectionId: 'test', environment: 'sandbox' };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tongyun-db-'));
  const filename = join(dir, 'test.sqlite');
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, credits INTEGER CHECK(credits >= 0), note TEXT); INSERT INTO users VALUES (1,'Example',10,NULL)");
  const core = new ChangeControl(filename, context);
  t.after(() => { core.close(); db.close(); rmSync(dir, { recursive: true, force: true }); resetQueries(); });
  return { db, core, filename };
}

function headers(task, token = 'test-token') {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Tongyun-Actor': 'agent:test', 'X-Tongyun-Task': task };
}

test('aborting a slow query returns cancelled and the same database still answers', async t => {
  const { db, filename } = fixture(t);
  db.exec("WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO users SELECT i,'Example',10,NULL FROM n");
  const server = createWorkbench({ filename, token: 'test-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const queryId = randomUUID();
  const task = 'cancel-task';
  const pending = fetch(`${base}/api/query`, {
    method: 'POST', headers: headers(task),
    body: JSON.stringify({ queryId, sql: 'SELECT count(*) AS n FROM users a CROSS JOIN users b CROSS JOIN users c' }),
  });
  let started = false;
  for (let attempt = 0; attempt < 40 && !started; attempt++) {
    const audit = await (await fetch(`${base}/api/audit`, { headers: headers(task) })).json();
    started = Boolean(audit.events?.some(event => event.operationId === queryId && event.action === 'query' && event.outcome === 'started'));
    if (!started) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(started, true);
  const wrong = await fetch(`${base}/api/queries/${queryId}/cancel`, { method: 'POST', headers: headers('other-task'), body: '{}' });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, 'QUERY_NOT_FOUND');
  const cancel = await fetch(`${base}/api/queries/${queryId}/cancel`, { method: 'POST', headers: headers(task), body: '{}' });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).status, 'cancelled');
  const body = await (await pending).json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'cancelled');
  assert.equal(body.queryId, queryId);
  const again = await fetch(`${base}/api/query`, { method: 'POST', headers: headers(task), body: JSON.stringify({ sql: 'SELECT name FROM users LIMIT 1' }) });
  const next = await again.json();
  assert.equal(next.status, 'completed');
  assert.equal(next.rows.length, 1);
  const audit = await (await fetch(`${base}/api/audit`, { headers: headers(task) })).json();
  assert.equal(audit.ok, true);
  assert.ok(audit.events.some(event => event.action === 'cancel_query' && event.outcome === 'succeeded' && event.operationId === queryId));
  assert.ok(audit.events.some(event => event.action === 'query' && event.outcome === 'cancelled' && event.operationId === queryId));
});

test('cancel before the query is registered still returns cancelled and a new query works', async t => {
  const { filename } = fixture(t);
  const server = createWorkbench({ filename, token: 'test-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const queryId = randomUUID();
  const task = 'early-cancel';
  const cancel = await fetch(`${base}/api/queries/${queryId}/cancel`, { method: 'POST', headers: headers(task), body: '{}' });
  assert.equal((await cancel.json()).status, 'cancelled');
  const blocked = await (await fetch(`${base}/api/query`, { method: 'POST', headers: headers(task), body: JSON.stringify({ queryId, sql: 'SELECT name FROM users' }) })).json();
  assert.equal(blocked.status, 'cancelled');
  const again = await (await fetch(`${base}/api/query`, { method: 'POST', headers: headers(task), body: JSON.stringify({ sql: 'SELECT name FROM users' }) })).json();
  assert.equal(again.status, 'completed');
  assert.equal(again.rows.length, 1);
});

test('mysql cancel uses another connection to KILL QUERY and the next call still runs', async () => {
  const killed = [];
  const connect = async () => ({
    promise() { return { query: async sql => { killed.push(sql); } }; },
    destroy() {},
  });
  const controller = new AbortController();
  const pending = withMysqlCancel({ connect, threadId: 42, signal: controller.signal, run: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, /QUERY_CANCELLED/);
  assert.deepEqual(killed, ['KILL QUERY 42']);
  const next = await withMysqlCancel({
    connect, threadId: 43, signal: new AbortController().signal,
    run: async () => ({ columns: ['n'], rows: [{ n: 1 }], truncated: false }),
  });
  assert.equal(next.rows[0].n, 1);
  assert.deepEqual(killed, ['KILL QUERY 42']);
});

test('redis scan chunk loop stops when aborted and a later scan completes', async () => {
  const controller = new AbortController();
  const seen = [];
  await assert.rejects(mapInChunks(['a', 'b', 'c'], 1, controller.signal, async ([key]) => {
    seen.push(key);
    if (key === 'a') controller.abort();
    return [{ key }];
  }), /QUERY_CANCELLED/);
  assert.deepEqual(seen, ['a']);
  const rows = await mapInChunks(['z'], 1, new AbortController().signal, async ([key]) => [{ key }]);
  assert.deepEqual(rows, [{ key: 'z' }]);
});

test('result filter matches any column and sort uses number and date types', () => {
  const rows = [
    { name: 'Ann', score: '10', seen: '2020-01-02', note: null },
    { name: 'Bob', score: '2', seen: '2020-01-10', note: '上海' },
    { name: 'Cyd', score: { $integer: '3' }, seen: null, note: '北京' },
  ];
  assert.deepEqual(filterRows(rows, ['name', 'note'], '海').map(row => row.name), ['Bob']);
  assert.equal(filterRows(rows, ['name', 'note'], '   ').length, 3);
  assert.equal(columnKind(rows.map(row => row.score)), 'number');
  assert.deepEqual(sortRows(rows, 'score', 'asc', 'number').map(row => row.name), ['Bob', 'Cyd', 'Ann']);
  assert.deepEqual(sortRows(rows, 'score', 'desc', 'number').map(row => row.name), ['Ann', 'Cyd', 'Bob']);
  assert.equal(columnKind(rows.map(row => row.seen)), 'date');
  const byDate = sortRows(rows, 'seen', 'asc', 'date');
  assert.equal(byDate[0].seen, '2020-01-02');
  assert.equal(byDate.at(-1).seen, null);
  const viewed = applyResultView(rows, ['name', 'score', 'seen', 'note'], { filter: 'c', sortColumn: 'score', sortDirection: 'asc' });
  assert.deepEqual(viewed.map(row => row.name), ['Cyd']);
});
