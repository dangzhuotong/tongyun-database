import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChangeControl, privateJson, ChangeError } from './change-control/core.mjs';
import { ConnectionStore } from './connections/store.mjs';
import { activateSecrets } from './connections/vault-cli.mjs';
import { RemoteService } from './connections/service.mjs';
import { beginQuery, finishQuery, normalizeQueryId, prepareCancel } from './queries/registry.mjs';

export function frameAncestorsPolicy(env = process.env) {
  if (env.TONGYUN_DESKTOP !== '1') return "frame-ancestors 'none'";
  if (env.TONGYUN_DESKTOP_DEV === '1') {
    return "frame-ancestors http://127.0.0.1:1420 http://localhost:1420 http://tauri.localhost tauri://localhost";
  }
  return "frame-ancestors http://tauri.localhost tauri://localhost";
}

export function directoryFromArgs(argv) {
  const index = argv.indexOf('--data-dir');
  if (index === -1) return '';
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) return '';
  return resolve(value);
}

function watchDesktopParent() {
  if (process.env.TONGYUN_DESKTOP !== '1') return;
  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    process.exit(0);
  };
  const parent = process.ppid;
  if (!process.stdin.isTTY) {
    process.stdin.on('end', quit);
    process.stdin.on('close', quit);
    process.stdin.resume();
  }
  const timer = setInterval(() => {
    if (process.ppid !== parent) {
      quit();
      return;
    }
    try { process.kill(parent, 0); } catch { quit(); }
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

async function runCancellable(body, context, fn) {
  const begun = beginQuery(normalizeQueryId(body?.queryId), { connectionId: context.connectionId, taskId: context.taskId, environment: context.environment });
  try {
    const value = await fn(begun.controller.signal, begun.queryId);
    if (begun.controller.signal.aborted) return { queryId: begun.queryId, status: 'cancelled' };
    return { ...value, queryId: begun.queryId, status: 'completed' };
  } catch (error) {
    if (error instanceof ChangeError && error.code === 'QUERY_CANCELLED') return { queryId: begun.queryId, status: 'cancelled' };
    throw error;
  } finally { finishQuery(begun.queryId); }
}

export function createWorkbench({ filename, token }) {
  const baseContext = { actor: 'human:local', taskId: 'local-demo', connectionId: 'local-sqlite', environment: 'sandbox' };
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const store = new ConnectionStore(dirname(filename));
  return createServer(async (req, res) => {
    const port = req.socket.localPort;
    const origin = `http://127.0.0.1:${port}`;
    const frameAncestors = frameAncestorsPolicy();
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; ${frameAncestors}; base-uri 'none'; form-action 'self'` };
    const reply = (status, value) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(privateJson(value)); };
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return reply(403, { ok: false, error: 'UNTRUSTED_ORIGIN' });
    let url;
    try { url = new URL(req.url, origin); } catch { return reply(400,{ok:false,error:'INVALID_URL'}); }
    if (!url.pathname.startsWith('/api/')) {
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/result-table.js': ['result-table.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/tokens.css': ['tokens.css', 'text/css'] };
      const target = files[url.pathname];
      if (req.method !== 'GET' || !target) return reply(404, { ok: false, error: 'NOT_FOUND' });
      let content = readFileSync(join(publicDir, target[0]), 'utf8');
      if (url.pathname === '/') content = content.replace('__SESSION_TOKEN__', token);
      res.writeHead(200, { ...headers, 'Content-Type': `${target[1]}; charset=utf-8` }); res.end(content); return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { ok: false, error: 'AUTH_REQUIRED' });
    if (!['GET', 'POST'].includes(req.method)) return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    let control;
    try {
      let body = {};
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { ok: false, error: 'JSON_REQUIRED' });
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 65536) return reply(413, { ok: false, error: 'BODY_TOO_LARGE' });
        }
        body = JSON.parse(text || '{}');
      }
      const testId = /^\/api\/connections\/([^/]+)\/test$/.exec(url.pathname)?.[1];
      const connectionId = testId ?? req.headers['x-tongyun-connection'] ?? 'local-sqlite';
      const config = connectionId === 'local-sqlite' ? null : store.get(connectionId);
      const context = { ...baseContext, connectionId, environment: config?.environment ?? baseContext.environment,
        actor: req.headers['x-tongyun-actor'] ?? baseContext.actor, taskId: req.headers['x-tongyun-task'] ?? baseContext.taskId };
      control = new ChangeControl(filename, context);
      const remote = config ? new RemoteService(control, config) : null;
      let result;
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/connections') result = control.operation('list_connections', null, () => ({ connections: [{ id:'local-sqlite', name:'本地 SQLite · 合成数据', engine:'sqlite', environment:'sandbox', allowWrites:true }, ...store.list()] }));
      else if (route === 'POST /api/connections') result = control.operation('add_connection', null, () => ({ connection: store.add(body) }));
      else if (req.method === 'POST' && testId && remote) result = await remote.test();
      else if (route === 'GET /api/capabilities') result = control.operation('discover', null, () => ({ version: 2, context, connection: config ? store.public(config) : { name: '本地 SQLite · 合成数据', id: context.connectionId, engine: 'sqlite',allowWrites:true }, tools: config?.engine === 'redis' ? ['redis_scan','redis_read','prepare_update','inspect_plan','apply','rollback','audit','plans'] : ['schema', 'browse', 'query', 'prepare_update', 'inspect_plan', 'apply', 'rollback', 'audit', 'plans'], constraints: { maxRows: 1000, queryTimeoutMs: config?.engine === 'redis' ? 5000 : 2000, writes: config ? (config.allowWrites ? 'guarded plan with durable local intent; remote commit may be unknown' : 'disabled') : 'single-row update with digest approval', identities: 'caller-supplied labels' } }));
      else if (route === 'GET /api/schema') result = remote ? await remote.schema(url.searchParams.get('table') ?? undefined) : control.tables();
      else if (route === 'GET /api/plans') result = remote ? await remote.list() : control.plans();
      else if (route === 'GET /api/audit') result = control.events(url.searchParams.get('before') ?? undefined);
      else if (route === 'POST /api/query') result = await runCancellable(body, context, (signal, queryId) => remote ? remote.query(body.sql, { signal, queryId }) : control.query(body.sql, [], { signal, queryId }));
      else if (/^POST \/api\/queries\/[^/]+\/cancel$/.test(route)) {
        const queryId = decodeURIComponent(url.pathname.split('/')[3]);
        const pending = prepareCancel(queryId, { connectionId: context.connectionId, taskId: context.taskId, environment: context.environment });
        control.noteQueryCancel(pending.queryId);
        pending.apply();
        result = { queryId: pending.queryId, status: 'cancelled' };
      }
      else if (route === 'POST /api/browse') result = remote ? await remote.browse(body.table, body.after) : await control.browse(body.table, body.after);
      else if (route === 'POST /api/redis/scan' && remote) result = await runCancellable(body, context, signal => remote.scan(body, { signal }));
      else if (route === 'POST /api/redis/read' && remote) result = await remote.readKey(body.key);
      else if (route === 'POST /api/plans') result = remote ? await remote.prepare(body) : control.prepareUpdate(body);
      else if (/^GET \/api\/plans\/[^/]+$/.test(route)) result = remote ? await remote.inspect(url.pathname.split('/')[3]) : control.inspect(url.pathname.split('/')[3]);
      else if (/^GET \/api\/queries\/[^/]+$/.test(route)) result = control.inspectQuery(url.pathname.split('/')[3]);
      else if (/^GET \/api\/operations\/[^/]+$/.test(route) && remote) result = await remote.inspectOperation(url.pathname.split('/')[3]);
      else if (/^POST \/api\/plans\/[^/]+\/cancel-confirmation$/.test(route)) result = remote ? await remote.cancel(url.pathname.split('/')[3]) : control.cancelConfirmation(url.pathname.split('/')[3]);
      else if (/^POST \/api\/plans\/[^/]+\/(apply|rollback)$/.test(route)) result = remote ? await remote.transition(url.pathname.split('/')[3], body.approvedDigest, url.pathname.endsWith('/rollback')) : control.transition(url.pathname.split('/')[3], body.approvedDigest, url.pathname.endsWith('/rollback'));
      else return reply(404, { ok: false, error: 'NOT_FOUND' });
      reply(200, { ok: true, ...result });
    } catch (error) {
      reply(error instanceof ChangeError ? 409 : 400, { ok: false, error: error instanceof ChangeError ? error.code : 'INVALID_REQUEST' });
    } finally { control?.close(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // TONGYUN_DATA_DIR: optional override for the data directory (defaults to .local/ next to the repo).
  // When set, all runtime files (sandbox.sqlite, agent-token, endpoint.json) are stored there instead.
  const localDir = directoryFromArgs(process.argv)
    || (process.env.TONGYUN_DATA_DIR
      ? resolve(process.env.TONGYUN_DATA_DIR)
      : fileURLToPath(new URL('../.local/', import.meta.url)));
  mkdirSync(localDir, { recursive: true, mode: 0o700 }); chmodSync(localDir, 0o700);
  watchDesktopParent();
  activateSecrets(localDir);
  const filename = join(localDir, 'sandbox.sqlite');
  if (!existsSync(filename)) {
    const db = new DatabaseSync(filename);
    db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused')), credits INTEGER NOT NULL CHECK(credits >= 0));
      INSERT INTO customers VALUES (1,'林小满','lin@example.com','active',120), (2,'周明远','zhou@example.com','active',80), (3,'许知夏','xu@example.com','paused',0), (4,'陈一禾','chen@example.com','active',240), (5,'叶青','ye@example.com','active',60);
      CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, stage TEXT NOT NULL);
      INSERT INTO projects VALUES (1,'Acme Web','development'),(2,'Demo API','testing');`);
    db.close();
  }
  chmodSync(filename, 0o600);
  const token = randomBytes(32).toString('hex');
  writeFileSync(join(localDir, 'agent-token'), token, { mode: 0o600 }); chmodSync(join(localDir, 'agent-token'), 0o600);
  const server = createWorkbench({ filename, token });
  const port = Number(process.env.TONGYUN_DATABASE_PORT ?? 4319);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(join(localDir, 'endpoint.json'), JSON.stringify({ url, tokenFile: process.env.TONGYUN_DATA_DIR ? join(localDir, 'agent-token') : '.local/agent-token', environment: 'sandbox' }), { mode: 0o600 });
    console.log(`橦云数据库 ${url}\nAgent 接入信息：.local/endpoint.json（令牌不写日志）；连接默认只读`);
  });
}
