import { DatabaseSync, constants as C } from 'node:sqlite';
import { privateJson } from './core.mjs';

process.once('message', workerData => {
const db = new DatabaseSync(workerData.filename, { readOnly: true });
try {
  db.exec('PRAGMA query_only = ON');
  const allowedTables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND sql LIKE 'CREATE TABLE%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_tongyun\\_%' ESCAPE '\\'").all().map(t => t.name));
  const functions = new Set(['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'ifnull', 'nullif', 'lower', 'upper', 'length', 'substr', 'substring', 'round', 'abs', 'typeof', 'date', 'datetime', 'strftime']);
  db.setAuthorizer((action, arg1, arg2) => {
    if (action === C.SQLITE_SELECT) return C.SQLITE_OK;
    if (action === C.SQLITE_READ && allowedTables.has(arg1)) return C.SQLITE_OK;
    if (action === C.SQLITE_FUNCTION && functions.has(arg2?.toLowerCase())) return C.SQLITE_OK;
    return C.SQLITE_DENY;
  });
  // SQLite prepare accepts a trailing statement; reject it rather than silently ignore it.
  if (workerData.sql.trim().replace(/;\s*$/, '').includes(';')) throw new Error('MULTIPLE_STATEMENTS');
  const sql = workerData.sql.trim().replace(/;\s*$/, '');
  const originalColumns = db.prepare(sql).columns().map(c => c.name);
  if (new Set(originalColumns).size !== originalColumns.length) throw new Error('COLUMN_ALIASES_REQUIRED');
  const statement = db.prepare(`SELECT * FROM (${sql}) LIMIT 1001`);
  statement.setReadBigInts(true);
  const columns = statement.columns().map(c => c.name);
  if (new Set(columns).size !== columns.length) throw new Error('COLUMN_ALIASES_REQUIRED');
  const rows = [];
  let truncated = false;
  let size = 0;
  for (const row of statement.iterate(...workerData.parameters)) {
    size += Buffer.byteLength(privateJson(row));
    if (rows.length >= 1000 || size > 2097152) { truncated = true; break; }
    rows.push(row);
  }
  process.send({ columns, rows, truncated });
} catch {
  process.send({ error: 'QUERY_REJECTED' });
} finally { db.close(); process.disconnect(); }
});
