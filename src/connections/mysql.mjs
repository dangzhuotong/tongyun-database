import mysql from 'mysql2';
import sqlParser from 'node-sql-parser';
import { requireValue } from './store.mjs';
import { ChangeError } from '../change-control/core.mjs';
import { digest } from './ledger.mjs';
import { withMysqlCancel } from './mysql-cancel.mjs';

const parser = new sqlParser.Parser();
const q = name => `\`${name.replaceAll('`', '``')}\``;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stableSchema = sql => sql.replace(/\bAUTO_INCREMENT=\d+\s*/g, '');
const scalar = value => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const allowedFunctions = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'IFNULL', 'NULLIF', 'LOWER', 'UPPER', 'LENGTH', 'CHAR_LENGTH', 'SUBSTRING', 'SUBSTR', 'ROUND', 'ABS', 'CONCAT', 'DATE', 'DATE_FORMAT', 'YEAR', 'MONTH', 'DAY', 'NOW']);

export function readSql(sql, database, tables) {
  requireValue(typeof sql === 'string' && sql.length > 0 && sql.length <= 20000, 'INVALID_QUERY');
  let ast;
  try { ast = parser.astify(sql, { database: 'MySQL' }); } catch { throw new ChangeError('QUERY_REJECTED'); }
  if(Array.isArray(ast)){requireValue(ast.length===1,'QUERY_REJECTED');ast=ast[0];}
  requireValue(ast.type === 'select', 'QUERY_REJECTED');
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    requireValue(!node.into?.keyword && !node.locking_read && !node.options?.length && node.type !== 'var' && node.operator !== ':=', 'QUERY_REJECTED');
    if (node.type === 'function' || node.type === 'aggr_func') {
      const name = typeof node.name === 'string' ? node.name : node.name?.name?.length === 1 ? node.name.name[0].value : '';
      requireValue(allowedFunctions.has(name?.toUpperCase()), 'QUERY_REJECTED');
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  }
  visit(ast);
  for (const item of parser.tableList(sql, { database: 'MySQL' })) {
    const [, db, table] = item.split('::');
    requireValue((db === 'null' || db === database) && tables.includes(table), 'QUERY_REJECTED');
  }
  // Execute reserialized AST, never comments or unparsed suffixes from the original text.
  return parser.sqlify(ast, { database: 'MySQL' });
}

export class MysqlAdapter {
  constructor(config) { this.config = config; }
  async connect() {
    const c = mysql.createConnection({ host: this.config.host, port: this.config.port, user: this.config.username,
      password: this.config.password, database: this.config.database, ssl: this.config.tls ? { rejectUnauthorized: true } : undefined,
      connectTimeout: 5000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true,
      dateStrings: true, jsonStrings: true, charset: 'utf8mb4', flags: ['-LOCAL_FILES'], });
    await new Promise((resolve, reject) => c.connect(error => error ? reject(new ChangeError('CONNECTION_FAILED')) : resolve()));
    return c;
  }
  async using(fn) {
    const c = await this.connect();
    try { await c.promise().query('SET SESSION max_execution_time=2000'); await c.promise().query('SET SESSION innodb_lock_wait_timeout=2'); return await fn(c); }
    finally { c.destroy(); }
  }
  async test() { return this.using(async c => { const [rows] = await c.promise().query('SELECT VERSION() AS version'); return { engine: 'mysql', version: rows[0].version }; }); }
  async tables(c) {
    const [rows] = await c.promise().execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME LIMIT 1000", [this.config.database]);
    return rows.map(r => ({ name: r.name, columns: [], sql: '' }));
  }
  async describe(c, table, writing = false) {
    requireValue(typeof table === 'string' && (await this.tables(c)).some(t => t.name === table), 'TABLE_NOT_ALLOWED');
    const [fields] = await c.promise().execute('SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,DATA_TYPE AS dataType,COLUMN_KEY AS columnKey,IS_NULLABLE AS nullable,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [this.config.database, table]);
    const [create] = await c.promise().query(`SHOW CREATE TABLE ${q(table)}`);
    const sql = create[0]['Create Table'];
    const columns = fields.map(f => ({ ...f, pk: f.columnKey === 'PRI' ? 1 : 0, notnull: f.nullable === 'NO' ? 1 : 0 }));
    if (writing) {
      const [grants] = await c.promise().query('SHOW GRANTS FOR CURRENT_USER()');
      const scopes = ['*.*', `${q(this.config.database)}.*`, `${q(this.config.database)}.${q(table)}`];
      const visible = grants.some(row => Object.values(row).some(line => {
        const match = /^GRANT (.+) ON (.+) TO /i.exec(line);
        return match && scopes.includes(match[2]) && /(^|, )(ALL PRIVILEGES|TRIGGER)(,|$)/i.test(match[1]);
      }));
      requireValue(visible, 'TRIGGER_VISIBILITY_REQUIRED');
      const [engines] = await c.promise().execute('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [this.config.database, table]);
      requireValue(engines[0]?.ENGINE === 'InnoDB', 'INNODB_REQUIRED');
      const [triggers] = await c.promise().execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?', [this.config.database, table]);
      requireValue(triggers.length === 0, 'TRIGGERS_UNSUPPORTED');
      const [fks] = await c.promise().execute('SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE (TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL) OR (REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?)', [this.config.database, table, this.config.database, table]);
      requireValue(fks.length === 0, 'FOREIGN_KEYS_UNSUPPORTED');
      const supported = new Set(['tinyint','smallint','mediumint','int','bigint','decimal','float','double','char','varchar','tinytext','text','mediumtext','longtext','date','datetime','timestamp','time','year','enum','set']);
      requireValue(fields.every(f => supported.has(f.dataType) && !/VIRTUAL GENERATED|STORED GENERATED|on update/i.test(f.extra)), 'COLUMN_TYPE_UNSUPPORTED');
    }
    return { name: table, sql, columns };
  }
  async schema(table) { return this.using(async c => table ? { tables: [await this.describe(c, table)] } : { tables: await this.tables(c) }); }
  bounded(c, sql, values = [], signal) {
    return new Promise((resolve, reject) => {
      const rows = []; let columns = []; let bytes = 0; let done = false;
      // Close this read socket now. withMysqlCancel rejects only after KILL QUERY finishes.
      const onAbort = () => finish(new ChangeError('QUERY_CANCELLED'));
      const timer = setTimeout(() => finish(new ChangeError(signal?.aborted ? 'QUERY_CANCELLED' : 'QUERY_TIMEOUT')), 2200);
      function finish(error, truncated = false) {
        if (done) return; done = true; clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error || truncated) c.destroy();
        if (error) reject(error); else resolve({ columns, rows, truncated });
      }
      if (signal?.aborted) { finish(new ChangeError('QUERY_CANCELLED')); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      const query = c.query({ sql, values, timeout: 2000 });
      query.on('fields', fields => { columns = fields.map(f => f.name); if (new Set(columns).size !== columns.length) finish(new ChangeError('COLUMN_ALIASES_REQUIRED')); });
      query.on('result', row => {
        if (done) return;
        if (signal?.aborted) { finish(new ChangeError('QUERY_CANCELLED')); return; }
        if(Object.values(row).some(value=>(typeof value==='string'&&value.length>2097152)||(Buffer.isBuffer(value)&&value.length>2097152))) {finish(null,true);return;}
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= 1000 || bytes > 2097152) finish(null, true); else rows.push({ ...row });
      });
      query.on('error', error => finish(new ChangeError(signal?.aborted ? 'QUERY_CANCELLED' : ['ER_QUERY_TIMEOUT','PROTOCOL_SEQUENCE_TIMEOUT'].includes(error.code)?'QUERY_TIMEOUT':'QUERY_FAILED')));
      query.on('end', () => finish(signal?.aborted ? new ChangeError('QUERY_CANCELLED') : null));
    });
  }
  async query(sql, options = {}) {
    return this.using(async c => {
      const [idRows] = await c.promise().query('SELECT CONNECTION_ID() AS id');
      const threadId = Number(idRows[0]?.id);
      requireValue(Number.isInteger(threadId) && threadId > 0, 'QUERY_FAILED');
      const canonical = readSql(sql, this.config.database, (await this.tables(c)).map(t => t.name));
      return withMysqlCancel({
        connect: () => this.connect(),
        threadId,
        signal: options.signal,
        run: async () => {
          if (options.signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
          await c.promise().query('START TRANSACTION READ ONLY');
          return this.bounded(c, `SELECT * FROM (${canonical}) AS tongyun_result LIMIT 1001`, [], options.signal);
        },
      });
    });
  }
  async browse(table, after) {
    return this.using(async c => {
      const schema = await this.describe(c, table);
      const keys = schema.columns.filter(f => f.pk);
      requireValue(keys.length === 1, 'SINGLE_PRIMARY_KEY_REQUIRED');
      const key = keys[0].name;
      requireValue(after === undefined || scalar(after), 'INVALID_CURSOR');
      const result = await this.bounded(c, `SELECT * FROM ${q(table)} ${after === undefined ? '' : `WHERE ${q(key)} > ?`} ORDER BY ${q(key)} LIMIT 1001`, after === undefined ? [] : [after]);
      return { ...result, key, table, nextCursor: result.truncated && result.rows.length ? String(result.rows.at(-1)[key]) : null };
    });
  }
  statement(table, changes, expected) {
    return { sql: `UPDATE ${q(table)} SET ${Object.keys(changes).map(k => `${q(k)}=?`).join(', ')} WHERE ${Object.keys(expected).map(k => `${q(k)} <=> ?`).join(' AND ')} LIMIT 1;`, parameters: [...Object.values(changes), ...Object.values(expected)] };
  }
  async row(c, table, key, value, lock = false) {
    const [columns]=await c.promise().execute('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[this.config.database,table]);
    requireValue(columns.length>0,'SCHEMA_CHANGED');
    const sizes=columns.map(column=>`COALESCE(OCTET_LENGTH(${q(column.name)}),0)`).join('+');
    const [lengths]=await c.promise().execute(`SELECT (${sizes}) AS bytes FROM ${q(table)} WHERE ${q(key)} <=> ? LIMIT 2${lock?' FOR UPDATE':''}`,[value]);
    requireValue(lengths.length===1,'EXPECTED_ONE_ROW');
    requireValue(Number(lengths[0].bytes)<=65536,'ROW_TYPE_UNSUPPORTED');
    const [rows] = await c.promise().execute(`SELECT * FROM ${q(table)} WHERE ${q(key)} <=> ? LIMIT 2${lock ? ' FOR UPDATE' : ''}`, [value]);
    requireValue(rows.length === 1, 'EXPECTED_ONE_ROW');
    const row = { ...rows[0] };
    requireValue(Object.values(row).every(scalar) && Buffer.byteLength(JSON.stringify(row)) <= 65536, 'ROW_TYPE_UNSUPPORTED');
    return row;
  }
  async prepare({ table, key, changes }) {
    requireValue(key !== null && scalar(key), 'KEY_REQUIRED');
    requireValue(changes && Object.getPrototypeOf(changes) === Object.prototype && Object.keys(changes).length, 'CHANGES_REQUIRED');
    return this.using(async c => {
      const schema = await this.describe(c, table);
      const keys = schema.columns.filter(f => f.pk); requireValue(keys.length === 1, 'SINGLE_PRIMARY_KEY_REQUIRED');
      const pk = keys[0].name;
      requireValue(Object.entries(changes).every(([name, value]) => schema.columns.some(f => f.name === name) && name !== pk && scalar(value)), 'INVALID_CHANGE');
      await c.promise().beginTransaction();
      try {
        const before = await this.row(c, table, pk, key, true);
        requireValue(stableSchema((await this.describe(c, table, true)).sql) === stableSchema(schema.sql), 'SCHEMA_CHANGED');
        const forward = this.statement(table, changes, before);
        await c.promise().execute(forward.sql, forward.parameters);
        const after = await this.row(c, table, pk, key);
        requireValue(!same(before, after), 'NO_CHANGE');
        const newValues = Object.fromEntries(Object.keys(changes).map(k => [k, after[k]]));
        const oldValues = Object.fromEntries(Object.keys(changes).map(k => [k, before[k]]));
        return { engine: 'mysql', table, key: pk, keyValue: before[pk], schema: schema.sql, before, after,
          forward: this.statement(table, newValues, before), rollback: this.statement(table, oldValues, after), connectionRevision: this.config.revision };
      } finally { await c.promise().rollback(); }
    });
  }
  async transition(plan, rollback) {
    return this.using(async c => {
      let committing = false;
      await c.promise().beginTransaction();
      try {
        // SELECT takes the metadata lock before checking the current schema.
        const current = await this.row(c, plan.table, plan.key, plan.keyValue, true);
        const schema = await this.describe(c, plan.table, true);
        requireValue(digest(stableSchema(schema.sql)) === digest(stableSchema(plan.schema)), 'SCHEMA_CHANGED');
        requireValue(same(current, rollback ? plan.after : plan.before), 'ROW_CONFLICT');
        const command = rollback ? plan.rollback : plan.forward;
        const [result] = await c.promise().execute(command.sql, command.parameters);
        requireValue(result.affectedRows === 1, 'ROW_CONFLICT');
        const after = await this.row(c, plan.table, plan.key, plan.keyValue);
        requireValue(same(after, rollback ? plan.before : plan.after), 'POSTCONDITION_FAILED');
        committing = true;
        await c.promise().commit();
        return { after };
      } catch (error) {
        if (committing) throw new ChangeError('OUTCOME_UNKNOWN');
        try { await c.promise().rollback(); } catch { throw new ChangeError('OUTCOME_UNKNOWN'); }
        throw error;
      }
    });
  }
}
