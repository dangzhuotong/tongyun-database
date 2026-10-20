import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = name => `"${name.replaceAll('"', '""')}"`;
const encode = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $integer: String(v) } : v);
const decode = value => JSON.parse(value, (_, v) => v && typeof v === 'object' && Object.keys(v).length === 1 && '$integer' in v ? BigInt(v.$integer) : v);
const equal = (a, b) => encode(a) === encode(b);
let queryProcesses = 0;

export class ChangeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const demand = (condition, code) => { if (!condition) throw new ChangeError(code); };
const scalar = v => v === null || typeof v === 'string' || typeof v === 'bigint' ||
  (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)));

/** Local reference adapter. Caller identities are labels, not authenticated principals. */
export class ChangeControl {
  constructor(filename, context) {
    demand(context && ['actor', 'taskId', 'connectionId', 'environment'].every(k =>
      typeof context[k] === 'string' && context[k].trim().length > 0), 'CONTEXT_REQUIRED');
    // This adapter opens an existing local file. Network engines use a separate local ledger.
    this.filename = realpathSync(filename);
    this.context = Object.fromEntries(['actor', 'taskId', 'connectionId', 'environment'].map(k => [k, context[k]]));
    this.db = new DatabaseSync(this.filename, { timeout: 5000, enableForeignKeyConstraints: true });
    // Readers must not prevent durable audit writes while a long query is running.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _tongyun_plans (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','applied','rolled_back'))
      );
      CREATE TABLE IF NOT EXISTS _tongyun_events (
        sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _tongyun_queries (
        operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, sql TEXT NOT NULL, parameters TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS _tongyun_events_operation ON _tongyun_events(json_extract(payload, '$.operationId'));
      CREATE INDEX IF NOT EXISTS _tongyun_plans_context ON _tongyun_plans (
        json_extract(payload, '$.context.taskId'), json_extract(payload, '$.context.connectionId'), json_extract(payload, '$.context.environment')
      );
      CREATE TRIGGER IF NOT EXISTS _tongyun_events_no_update BEFORE UPDATE ON _tongyun_events
        BEGIN SELECT RAISE(ABORT, 'append-only audit'); END;
      CREATE TRIGGER IF NOT EXISTS _tongyun_events_no_delete BEFORE DELETE ON _tongyun_events
        BEGIN SELECT RAISE(ABORT, 'append-only audit'); END;
    `);
  }

  close() { this.db.close(); }

  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  append(event) {
    const previous = this.db.prepare('SELECT hash FROM _tongyun_events ORDER BY sequence DESC LIMIT 1').get()?.hash ?? '';
    const payload = JSON.stringify({ eventId: randomUUID(), at: new Date().toISOString(), ...this.context, ...event });
    this.db.prepare('INSERT INTO _tongyun_events(payload, previous_hash, hash) VALUES (?, ?, ?)')
      .run(payload, previous, hash([previous, payload]));
  }

  operation(action, planId, fn) {
    const operationId = randomUUID();
    this.atomic(() => this.append({ operationId, action, planId, outcome: 'started' }));
    try {
      return this.atomic(() => {
        const result = fn();
        this.append({ operationId, action, planId: result.id ?? planId, outcome: 'succeeded', digest: result.digest });
        return result;
      });
    } catch (error) {
      this.atomic(() => this.append({ operationId, action, planId, outcome: 'failed',
        code: error instanceof ChangeError ? error.code : 'DATABASE_ERROR' }));
      // Database error messages can contain actual values. Never return them by default.
      throw error instanceof ChangeError ? error : new ChangeError('DATABASE_ERROR');
    }
  }

  schema(table) {
    demand(typeof table === 'string' && table.length > 0 && !/^(sqlite_|_tongyun_)/i.test(table), 'TABLE_NOT_ALLOWED');
    const entry = this.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
    demand(entry && /^CREATE\s+TABLE\b/i.test(entry.sql), 'ORDINARY_TABLE_REQUIRED');
    const columns = this.db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
    demand(columns.length > 0 && columns.every(c => c.hidden === 0), 'GENERATED_COLUMNS_UNSUPPORTED');
    const keys = columns.filter(c => c.pk > 0);
    demand(keys.length === 1, 'SINGLE_PRIMARY_KEY_REQUIRED');
    demand(!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?").get(table), 'TRIGGERS_UNSUPPORTED');
    // Reject incoming and outgoing foreign keys, including cascades and deferred checks.
    for (const other of this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
      const fks = this.db.prepare(`PRAGMA foreign_key_list(${quote(other.name)})`).all();
      demand(!fks.some(f => other.name === table || f.table.toLowerCase() === table.toLowerCase()), 'FOREIGN_KEYS_UNSUPPORTED');
    }
    return { sql: entry.sql, columns: columns.map(c => c.name), key: keys[0].name };
  }

  row(table, key, value) {
    const statement = this.db.prepare(`SELECT * FROM ${quote(table)} WHERE ${quote(key)} IS ?`);
    statement.setReadBigInts(true);
    const rows = statement.all(value);
    demand(rows.length === 1, 'EXPECTED_ONE_ROW');
    const row = Object.fromEntries(Object.entries(rows[0]));
    demand(Object.values(row).every(scalar), 'ROW_TYPE_UNSUPPORTED');
    return row;
  }

  statement(table, changes, expected) {
    const names = Object.keys(changes);
    const keys = Object.keys(expected);
    return {
      sql: `UPDATE ${quote(table)} SET ${names.map(n => `${quote(n)} = ?`).join(', ')} WHERE ${keys.map(n => `${quote(n)} IS ?`).join(' AND ')};`,
      parameters: [...Object.values(changes), ...Object.values(expected)],
    };
  }

  prepareUpdate({ table, key, changes }) {
    return this.operation('prepare_update', null, () => {
      demand(key !== null && scalar(key), 'KEY_REQUIRED');
      demand(changes && Object.getPrototypeOf(changes) === Object.prototype && Object.keys(changes).length > 0, 'CHANGES_REQUIRED');
      const schema = this.schema(table);
      demand(Object.entries(changes).every(([name, value]) => schema.columns.includes(name) && name !== schema.key && scalar(value)), 'INVALID_CHANGE');
      const before = this.row(table, schema.key, key);
      // Apply inside a savepoint to capture SQLite affinity conversions exactly.
      this.db.exec('SAVEPOINT preview');
      let after;
      try {
        const forward = this.statement(table, changes, before);
        demand(this.db.prepare(forward.sql).run(...forward.parameters).changes === 1, 'ROW_CONFLICT');
        after = this.row(table, schema.key, key);
      } finally { this.db.exec('ROLLBACK TO preview; RELEASE preview'); }
      demand(!equal(before, after), 'NO_CHANGE');
      const normalized = Object.fromEntries(Object.keys(changes).map(k => [k, after[k]]));
      const original = Object.fromEntries(Object.keys(changes).map(k => [k, before[k]]));
      const payload = {
        id: randomUUID(), version: 1, context: this.context, database: this.filename,
        table, key: schema.key, keyValue: before[schema.key], schema: schema.sql, before, after,
        preview: { sql: `SELECT * FROM ${quote(table)} WHERE ${quote(schema.key)} IS ?;`, parameters: [before[schema.key]] },
        forward: this.statement(table, normalized, before),
        rollback: this.statement(table, original, after),
      };
      const serialized = encode(payload);
      const digest = hash(serialized);
      this.db.prepare("INSERT INTO _tongyun_plans VALUES (?, ?, ?, 'prepared')").run(payload.id, digest, serialized);
      return { id: payload.id, digest, state: 'prepared', affectedRows: 1, forwardSql: payload.forward.sql, rollbackSql: payload.rollback.sql };
    });
  }

  load(id) {
    const stored = this.db.prepare('SELECT * FROM _tongyun_plans WHERE id = ?').get(id);
    demand(stored, 'PLAN_NOT_FOUND');
    demand(hash(stored.payload) === stored.digest, 'PLAN_TAMPERED');
    const plan = decode(stored.payload);
    demand(plan.database === this.filename && ['taskId', 'connectionId', 'environment'].every(k => plan.context[k] === this.context[k]), 'CONTEXT_MISMATCH');
    return { stored, plan };
  }

  inspect(id) {
    return this.operation('inspect_plan', id, () => {
      const { stored, plan } = this.load(id);
      // Explicit inspection is sensitive: includes private old/new values and rollback parameters.
      return { ...plan, digest: stored.digest, state: stored.state };
    });
  }

  transition(id, approvedDigest, rollback = false) {
    return this.operation(rollback ? 'rollback' : 'apply', id, () => {
      const { stored, plan } = this.load(id);
      demand(typeof approvedDigest === 'string' && approvedDigest === stored.digest, 'APPROVAL_REQUIRED');
      const desiredState = rollback ? 'rolled_back' : 'applied';
      if (stored.state === desiredState) return { id, digest: stored.digest, state: desiredState, replayed: true, affectedRows: 0 };
      demand(stored.state === (rollback ? 'applied' : 'prepared'), 'INVALID_STATE');
      demand(this.schema(plan.table).sql === plan.schema, 'SCHEMA_CHANGED');
      const expected = rollback ? plan.after : plan.before;
      demand(equal(this.row(plan.table, plan.key, plan.keyValue), expected), 'ROW_CONFLICT');
      this.append({ action: rollback ? 'approve_rollback' : 'approve_apply', planId: id, digest: stored.digest, outcome: 'recorded' });
      const statement = rollback ? plan.rollback : plan.forward;
      demand(this.db.prepare(statement.sql).run(...statement.parameters).changes === 1, 'ROW_CONFLICT');
      demand(equal(this.row(plan.table, plan.key, plan.keyValue), rollback ? plan.before : plan.after), 'POSTCONDITION_FAILED');
      this.db.prepare('UPDATE _tongyun_plans SET state = ? WHERE id = ?').run(desiredState, id);
      return { id, digest: stored.digest, state: desiredState, affectedRows: 1, replayed: false };
    });
  }

  events(before) {
    return this.operation('read_audit', null, () => {
      demand(before === undefined || (typeof before === 'string' && /^[1-9]\d{0,15}$/.test(before)), 'INVALID_AUDIT_CURSOR');
      const rows = (before === undefined ? this.db.prepare('SELECT * FROM _tongyun_events ORDER BY sequence DESC LIMIT 200').all() :
        this.db.prepare('SELECT * FROM _tongyun_events WHERE sequence < ? ORDER BY sequence DESC LIMIT 200').all(Number(before))).reverse();
      let previous = rows[0]?.previous_hash ?? '';
      for (const row of rows) {
        demand(row.previous_hash === previous && hash([previous, row.payload]) === row.hash, 'AUDIT_CHAIN_INVALID');
        previous = row.hash;
      }
      return { events: rows.map(r => ({ sequence: r.sequence, ...JSON.parse(r.payload), hash: r.hash })), verified: true, verificationScope: 'returned-segment', limit: 200,
        nextBefore: rows[0]?.sequence > 1 ? String(rows[0].sequence) : null };
    });
  }

  tables() {
    return this.operation('read_schema', null, () => ({
      tables: this.db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_tongyun\\_%' ESCAPE '\\' ORDER BY name").all()
        .map(t => ({ name: t.name, columns: this.db.prepare(`PRAGMA table_xinfo(${quote(t.name)})`).all(), sql: t.sql })),
    }));
  }

  plans() {
    return this.operation('list_plans', null, () => ({
      plans: this.db.prepare("SELECT id, digest, state, payload FROM _tongyun_plans WHERE json_extract(payload, '$.context.taskId') = ? AND json_extract(payload, '$.context.connectionId') = ? AND json_extract(payload, '$.context.environment') = ? ORDER BY rowid DESC LIMIT 100")
        .all(this.context.taskId, this.context.connectionId, this.context.environment)
        .map(row => ({ ...row, payload: decode(row.payload) }))
        .filter(row => ['taskId', 'connectionId', 'environment'].every(k => row.payload.context[k] === this.context[k]))
        .map(row => ({ id: row.id, digest: row.digest, state: row.state, table: row.payload.table, actor: row.payload.context.actor })),
    }));
  }

  cancelConfirmation(id) {
    return this.operation('cancel_confirmation', id, () => { const { stored } = this.load(id); return { id, digest: stored.digest, state: stored.state }; });
  }

  inspectQuery(id) {
    return this.operation('inspect_query', null, () => {
      const query = this.db.prepare('SELECT * FROM _tongyun_queries WHERE operation_id = ? AND task_id = ?').get(id, this.context.taskId);
      demand(query, 'QUERY_NOT_FOUND');
      const source=this.db.prepare("SELECT payload FROM _tongyun_events WHERE json_extract(payload,'$.operationId')=? AND json_extract(payload,'$.action')='query' ORDER BY sequence LIMIT 1").get(id);
      const context=source?JSON.parse(source.payload):null;
      demand(context&&['taskId','connectionId','environment'].every(k=>context[k]===this.context[k]),'CONTEXT_MISMATCH');
      return { operationId: id, sql: query.sql, parameters: decode(query.parameters) };
    });
  }

  async browse(table, after) {
    const info = this.operation('prepare_browse', null, () => {
      const schema = this.schema(table);
      const key = this.db.prepare(`PRAGMA table_info(${quote(table)})`).all().find(c => c.pk === 1);
      demand(key.type.toUpperCase() === 'INTEGER', 'INTEGER_CURSOR_REQUIRED');
      demand(after === undefined || (typeof after === 'string' && /^-?\d{1,19}$/.test(after)), 'INVALID_CURSOR');
      return schema;
    });
    const sql = `SELECT * FROM ${quote(table)}${after === undefined ? '' : ` WHERE ${quote(info.key)} > ?`} ORDER BY ${quote(info.key)} LIMIT 1001`;
    const result = await this.query(sql, after === undefined ? [] : [BigInt(after)]);
    return { ...result, table, key: info.key, nextCursor: result.truncated && result.rows.length ? String(result.rows.at(-1)[info.key]) : null };
  }

  noteQueryCancel(queryId) {
    this.atomic(() => this.append({ action: 'cancel_query', operationId: queryId, outcome: 'succeeded' }));
  }

  async query(sql, parameters = [], options = {}) {
    const signal = options?.signal;
    const operationId = options?.queryId ?? randomUUID();
    this.atomic(() => this.append({ operationId, action: 'query', outcome: 'started', sqlDigest: hash(sql ?? null) }));
    try {
      if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
      demand(typeof sql === 'string' && sql.length > 0 && sql.length <= 20000, 'INVALID_QUERY');
      this.atomic(() => this.db.prepare('INSERT INTO _tongyun_queries VALUES (?, ?, ?, ?)').run(operationId, this.context.taskId, sql, encode(parameters)));
      demand(queryProcesses < 4, 'QUERY_BUSY');
      queryProcesses++;
      let result;
      try { result = await new Promise((resolve, reject) => {
        // A worker thread cannot interrupt a synchronous native SQLite call.
        // A separate process can be killed; await exit before writing audit to release read locks.
        const worker = fork(fileURLToPath(new URL('./query-worker.mjs', import.meta.url)), [], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', env: {},
        });
        let result;
        let timedOut = false;
        let aborted = false;
        let settled = false;
        const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 2000);
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve(value);
        };
        const onAbort = () => { aborted = true; worker.kill('SIGKILL'); };
        worker.once('message', message => { result = message; });
        worker.once('error', () => finish(new ChangeError('QUERY_FAILED')));
        worker.once('exit', code => {
          if (aborted || signal?.aborted) finish(new ChangeError('QUERY_CANCELLED'));
          else if (timedOut) finish(new ChangeError('QUERY_TIMEOUT'));
          else if (code !== 0 || !result) finish(new ChangeError('QUERY_FAILED'));
          else if (result.error) finish(new ChangeError(result.error));
          else finish(null, result);
        });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        if (!aborted) worker.send({ filename: this.filename, sql, parameters });
      }); } finally { queryProcesses--; }
      this.atomic(() => this.append({ operationId, action: 'query', outcome: 'succeeded', rowCount: result.rows.length, truncated: result.truncated }));
      return { operationId, ...result };
    } catch (error) {
      const code = error instanceof ChangeError ? error.code : 'QUERY_FAILED';
      this.atomic(() => this.append({ operationId, action: 'query', outcome: code === 'QUERY_CANCELLED' ? 'cancelled' : 'failed', code }));
      throw error instanceof ChangeError ? error : new ChangeError('QUERY_FAILED');
    }
  }
}

export const privateJson = encode;
