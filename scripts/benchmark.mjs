import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChangeControl } from '../src/change-control/core.mjs';
const dir = mkdtempSync(join(tmpdir(), 'tongyun-million-'));
const filename = join(dir, 'million.sqlite');
const db = new DatabaseSync(filename);
let core;
try {
  const start = performance.now();
  db.exec(`CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount INTEGER NOT NULL);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000000)
    INSERT INTO records SELECT i, 'example-' || i, i % 1000 FROM n;`);
  const seedMs = performance.now() - start;
  core = new ChangeControl(filename, { actor: 'benchmark', taskId: 'million-row', connectionId: 'temporary', environment: 'sandbox' });
  const measurements = [];
  for (const after of [undefined, '500000', '999000']) {
    const begin = performance.now(); const page = await core.browse('records', after);
    measurements.push({ after: after ?? null, elapsedMs: Math.round((performance.now() - begin) * 100) / 100, rows: page.rows.length, firstId: String(page.rows[0].id), lastId: String(page.rows.at(-1).id), nextCursor: page.nextCursor });
  }
  const explain = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM records WHERE id > ? ORDER BY id LIMIT 1001').all(500000);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, totalRows: 1000000, seedMs: Math.round(seedMs), measurements, explain, scope: 'local SQLite; includes query subprocess startup and audit; excludes HTTP and browser render; warm-cache single samples, not an SLA' }, null, 2));
} finally { core?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
