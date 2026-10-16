import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChangeControl } from '../src/change-control/core.mjs';
import { createWorkbench } from '../src/server.mjs';

const context = { actor: 'agent:test', taskId: 'task-1', connectionId: 'test', environment: 'sandbox' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tongyun-db-'));
  const filename = join(dir, 'test.sqlite');
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, credits INTEGER CHECK(credits >= 0), note TEXT); INSERT INTO users VALUES (1,'Example',10,NULL)");
  const core = new ChangeControl(filename, context);
  t.after(() => { core.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, core, filename };
}
const prepare = core => core.prepareUpdate({ table: 'users', key: 1, changes: { credits: 20, note: "quote ' and unicode 中文" } });

test('preview is non-mutating; explicit digest applies; guarded rollback restores null and text', t => {
  const { db, core } = fixture(t); const plan = prepare(core);
  assert.equal(db.prepare('SELECT credits FROM users').get().credits, 10);
  const detail = core.inspect(plan.id);
  assert.match(detail.rollback.sql, /UPDATE/); assert.ok(detail.rollback.parameters.includes(null));
  assert.throws(() => core.transition(plan.id, 'wrong'), /APPROVAL_REQUIRED/);
  assert.equal(core.transition(plan.id, plan.digest).affectedRows, 1);
  assert.equal(db.prepare('SELECT credits FROM users').get().credits, 20);
  assert.equal(core.transition(plan.id, plan.digest).replayed, true);
  assert.equal(core.transition(plan.id, plan.digest, true).affectedRows, 1);
  assert.deepEqual({ ...db.prepare('SELECT * FROM users').get() }, { id: 1, name: 'Example', credits: 10, note: null });
  assert.equal(core.transition(plan.id, plan.digest, true).replayed, true);
  assert.throws(() => core.transition(plan.id, plan.digest), /INVALID_STATE/);
});
test('concurrent change blocks stale execution and later change blocks rollback', t => {
  const { db, core } = fixture(t); const plan = prepare(core);
  db.exec("UPDATE users SET name='Someone else' WHERE id=1");
  assert.throws(() => core.transition(plan.id, plan.digest), /ROW_CONFLICT/);
  db.exec("UPDATE users SET name='Example' WHERE id=1"); core.transition(plan.id, plan.digest);
  db.exec('UPDATE users SET credits=25 WHERE id=1');
  assert.throws(() => core.transition(plan.id, plan.digest, true), /ROW_CONFLICT/);
  assert.equal(db.prepare('SELECT credits FROM users').get().credits, 25);
});
test('SQL constraints, missing keys, unknown fields and no-op changes fail with audit', t => {
  const { core } = fixture(t);
  assert.throws(() => core.prepareUpdate({ table: 'users', key: 1, changes: { credits: -1 } }), /DATABASE_ERROR/);
  assert.throws(() => core.prepareUpdate({ table: 'users', key: 99, changes: { credits: 2 } }), /EXPECTED_ONE_ROW/);
  assert.throws(() => core.prepareUpdate({ table: 'users', key: 1, changes: { id: 2 } }), /INVALID_CHANGE/);
  assert.throws(() => core.prepareUpdate({ table: 'users', key: 1, changes: { credits: 10 } }), /NO_CHANGE/);
  assert.equal(core.events().events.filter(e => e.outcome === 'failed').length, 4);
});
test('trigger and foreign key effects refuse automated rollback promises', t => {
  const { core, db } = fixture(t);
  db.exec('CREATE TRIGGER touched AFTER UPDATE ON users BEGIN SELECT 1; END');
  assert.throws(() => prepare(core), /TRIGGERS_UNSUPPORTED/);
  db.exec('DROP TRIGGER touched; CREATE TABLE child(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');
  assert.throws(() => prepare(core), /FOREIGN_KEYS_UNSUPPORTED/);
});
test('schema drift, tampered plans and mismatched tasks cannot execute', t => {
  const { core, db, filename } = fixture(t); const plan = prepare(core);
  const other = new ChangeControl(filename, { ...context, taskId: 'another-task' });
  try { assert.throws(() => other.transition(plan.id, plan.digest), /CONTEXT_MISMATCH/); } finally { other.close(); }
  db.exec('ALTER TABLE users ADD COLUMN extra TEXT');
  assert.throws(() => core.transition(plan.id, plan.digest), /SCHEMA_CHANGED/);
  db.prepare('UPDATE _tongyun_plans SET payload=? WHERE id=?').run('{}', plan.id);
  assert.throws(() => core.transition(plan.id, plan.digest), /PLAN_TAMPERED/);
});
test('audit is append-only, verifiable, and excludes SQL parameter values', t => {
  const { core, db } = fixture(t); const plan = prepare(core); core.transition(plan.id, plan.digest);
  const audit = core.events(); assert.equal(audit.verified, true);
  assert.ok(audit.events.some(e => e.action === 'approve_apply'));
  assert.ok(!JSON.stringify(audit).includes("quote ' and unicode"));
  assert.throws(() => db.exec('DELETE FROM _tongyun_events'), /append-only/);
  assert.throws(() => db.exec("UPDATE _tongyun_events SET payload='{}'"), /append-only/);
});
test('failed audit commit rolls back business mutation and plan transition together', t => {
  const { core, db } = fixture(t); const plan = prepare(core);
  db.exec("CREATE TRIGGER block_success BEFORE INSERT ON _tongyun_events WHEN json_extract(NEW.payload,'$.action')='apply' AND json_extract(NEW.payload,'$.outcome')='succeeded' BEGIN SELECT RAISE(ABORT,'disk-like failure'); END");
  assert.throws(() => core.transition(plan.id, plan.digest), /DATABASE_ERROR/);
  assert.equal(db.prepare('SELECT credits FROM users').get().credits, 10);
  assert.equal(core.inspect(plan.id).state, 'prepared');
});
test('read query rejects writes, attached files, audit tables and multiple statements', async t => {
  const { core, db } = fixture(t);
  assert.equal((await core.query('SELECT * FROM users')).rows.length, 1);
  for (const sql of ["UPDATE users SET credits=0", "SELECT * FROM _tongyun_plans", "ATTACH DATABASE ':memory:' AS other", 'SELECT * FROM users; DELETE FROM users', 'PRAGMA writable_schema=ON', 'SELECT id, id FROM users']) {
    await assert.rejects(core.query(sql), /QUERY_REJECTED/);
  }
  assert.equal(db.prepare('SELECT credits FROM users').get().credits, 10);
});
test('1000-row cap and indexed cursor do not duplicate or skip pages', async t => {
  const { core, db } = fixture(t);
  db.exec("WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<2005) INSERT INTO users SELECT i,'Example',10,NULL FROM n");
  const page1 = await core.browse('users'); assert.equal(page1.rows.length, 1000); assert.equal(page1.nextCursor, '1000');
  const page2 = await core.browse('users', page1.nextCursor); assert.equal(page2.rows[0].id, 1001n); assert.equal(page2.rows.length, 1000);
  const page3 = await core.browse('users', page2.nextCursor); assert.equal(page3.rows.length, 5); assert.equal(page3.nextCursor, null);
  assert.equal((await core.query('SELECT * FROM users')).rows.length, 1000);
});
test('timed-out worker stops; private query and cancelled confirmation remain traceable', async t => {
  const { core, db } = fixture(t);
  const plan = prepare(core); core.cancelConfirmation(plan.id);
  assert.equal(core.inspect(plan.id).state, 'prepared');
  const query = await core.query('SELECT name FROM users');
  assert.equal(core.inspectQuery(query.operationId).sql, 'SELECT name FROM users');
  db.exec("WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO users SELECT i,'Example',10,NULL FROM n");
  const timedOut = assert.rejects(core.query('SELECT count(*) FROM users a CROSS JOIN users b CROSS JOIN users c'), /QUERY_TIMEOUT/);
  assert.equal((await core.query('SELECT name FROM users LIMIT 1')).rows.length, 1);
  assert.equal(core.events().verified, true);
  await timedOut;
  assert.ok(core.events().events.some(e => e.code === 'QUERY_TIMEOUT'));
  assert.equal((await core.query('SELECT name FROM users LIMIT 1')).rows.length, 1);
});
test('HTTP authenticates agents, rejects external origins, and shares plans with UI', async t => {
  const { filename, core } = fixture(t); const server = createWorkbench({ filename, token: 'test-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/schema`)).status, 401);
  assert.equal((await fetch(`${base}/api/schema`, { headers: { Origin: 'https://attacker.example', Authorization: 'Bearer test-token' } })).status, 403);
  const response = await fetch(`${base}/api/plans`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', 'X-Tongyun-Actor': 'agent:demo', 'X-Tongyun-Task': 'shared-task' }, body: JSON.stringify({ table: 'users', key: 1, changes: { credits: 30 } }) });
  const plan = await response.json(); assert.equal(plan.ok, true);
  const list = await (await fetch(`${base}/api/plans`, { headers: { Authorization: 'Bearer test-token', 'X-Tongyun-Task': 'shared-task' } })).json();
  assert.equal(list.plans[0].id, plan.id);
  assert.ok(core.events().events.some(e => e.actor === 'agent:demo'));
  const html = await (await fetch(base)).text(); assert.ok(html.includes('变更检查器')); assert.ok(!html.includes('__SESSION_TOKEN__'));
});
