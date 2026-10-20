import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RemoteLedger } from './ledger.mjs';
import { MysqlAdapter } from './mysql.mjs';
import { RedisAdapter } from './redis.mjs';
import { requireValue } from './store.mjs';
import { ChangeError } from '../change-control/core.mjs';

let active = 0;
export class RemoteService {
  constructor(core, config) {
    this.core = core; this.config = config; this.ledger = new RemoteLedger(core);
    this.adapter = config.engine === 'mysql' ? new MysqlAdapter(config) : new RedisAdapter(config);
  }
  async track(action, fn, id = null, request = undefined) {
    return this.ledger.track(action, async operationId => {
      requireValue(active < 4, 'QUERY_BUSY'); active++;
      try { return await fn(operationId); } finally { active--; }
    }, id, request);
  }
  async test() { return this.track('test_connection', () => this.adapter.test()); }
  async mysqlRead(action,args,signal) {
    return new Promise((resolve,reject)=>{
      const child=fork(fileURLToPath(new URL('./mysql-reader.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',env:{}});
      let result;let timedOut=false;let aborted=false;
      const onAbort=()=>{aborted=true;try{child.send({cancel:true})}catch{/* child already gone */}};
      if(signal){if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});}
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},8000);
      child.on('message',message=>{result=message});
      child.once('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(new ChangeError('QUERY_FAILED'))});
      child.once('exit',code=>{
        clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
        if(aborted||signal?.aborted)reject(new ChangeError('QUERY_CANCELLED'));
        else if(timedOut)reject(new ChangeError('QUERY_TIMEOUT'));
        else if(code!==0||!result)reject(new ChangeError('QUERY_FAILED'));
        else if(result.error)reject(new ChangeError(result.error));
        else resolve(result.result);
      });
      if(!aborted)child.send({config:this.config,action,args});
    });
  }
  async schema(table) { requireValue(this.config.engine === 'mysql', 'ENGINE_MISMATCH'); return this.track('read_schema', () => this.adapter.schema(table),null,{table:table??null}); }
  async query(sql, options = {}) {
    requireValue(this.config.engine === 'mysql', 'ENGINE_MISMATCH');
    const signal = options.signal;
    return this.track('query', async operationId => {
      if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
      requireValue(typeof sql === 'string' && sql.length <= 20000, 'INVALID_QUERY');
      this.core.atomic(() => this.core.db.prepare('INSERT INTO _tongyun_queries VALUES (?, ?, ?, ?)').run(operationId, this.core.context.taskId, sql, '[]'));
      return this.mysqlRead('query',[sql], signal);
    },null,{sql});
  }
  async browse(table, after) { requireValue(this.config.engine === 'mysql', 'ENGINE_MISMATCH'); return this.track('browse', () => this.mysqlRead('browse',[table,after]),null,{table,after:after??null}); }
  async scan(input, options = {}) {
    requireValue(this.config.engine === 'redis', 'ENGINE_MISMATCH');
    const signal = options.signal;
    return this.track('redis_scan', async () => {
      if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
      const deadline=Date.now()+5000;
      this.core.db.exec('CREATE TABLE IF NOT EXISTS _tongyun_scan_cursors(id TEXT PRIMARY KEY,context TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL)');
      const scope = JSON.stringify([this.core.context.taskId, this.config.id, input.pattern ?? '*']);
      let data;
      if (typeof input.cursor === 'string' && input.cursor.startsWith('page:')) {
        const cursor = this.core.db.prepare('SELECT * FROM _tongyun_scan_cursors WHERE id=? AND context=? AND expires>?').get(input.cursor, scope, Date.now());
        requireValue(cursor, 'CURSOR_EXPIRED');
        data = JSON.parse(cursor.payload);
      } else data = await this.adapter.scan({ cursor: input.cursor ?? '0', pattern: input.pattern ?? '*' },deadline-Date.now(), signal);
      // Fill a short spill page from the next server batch without unbounded scanning.
      let rounds=0;
      while(data.rows.length<1000&&data.cursor!=='0'&&rounds<2&&Date.now()<deadline-100){
        if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
        const batch=await this.adapter.scan({cursor:data.cursor,pattern:input.pattern??'*'},deadline-Date.now(), signal);
        const seen=new Set(data.rows.map(r=>r.key));data.rows.push(...batch.rows.filter(r=>!seen.has(r.key)));data.cursor=batch.cursor;rounds++;
      }
      const rows = []; let bytes=0;
      for(const row of data.rows) { const size=Buffer.byteLength(JSON.stringify(row)); if(rows.length>=1000 || bytes+size>2097152) break; rows.push(row);bytes+=size; }
      let nextCursor = data.cursor === '0' ? null : data.cursor;
      if (data.rows.length > rows.length) {
        nextCursor = `page:${randomUUID()}`;
        this.core.atomic(() => {
          this.core.db.prepare('DELETE FROM _tongyun_scan_cursors WHERE expires<?').run(Date.now());
          this.core.db.prepare('INSERT INTO _tongyun_scan_cursors VALUES (?, ?, ?, ?)').run(nextCursor, scope, JSON.stringify({ ...data, rows: data.rows.slice(rows.length) }), Date.now() + 600000);
        });
      }
      return { columns: ['key','type','ttlMs','memoryBytes'], rows, nextCursor, truncated: Boolean(nextCursor), scanHint: 1000 };
    },null,input);
  }
  async readKey(key) { requireValue(this.config.engine === 'redis', 'ENGINE_MISMATCH'); return this.track('redis_read', () => this.adapter.read(key),null,{key}); }
  async prepare(input) {
    return this.track('prepare_update', async () => {
      requireValue(this.config.allowWrites && this.config.environment !== 'production', 'CONNECTION_READ_ONLY');
      return this.ledger.save(await this.adapter.prepare(input));
    },null,input);
  }
  async inspect(id) { return this.track('inspect_plan', () => this.ledger.load(id), id); }
  async list() { return this.track('list_plans', () => this.ledger.list()); }
  async inspectOperation(id) { return this.track('inspect_operation',()=>this.ledger.inspectRequest(id)); }
  async cancel(id) { return this.track('cancel_confirmation', () => { const plan = this.ledger.load(id); return { id, state: plan.state }; }, id); }
  async transition(id, approvedDigest, rollback) {
    return this.track(rollback ? 'rollback' : 'apply', async () => {
      const { plan, replayed } = this.ledger.begin(id, approvedDigest, rollback, this.config);
      if (replayed) return { id, state: plan.state, replayed: true, affectedRows: 0 };
      let result;
      try { result = await this.adapter.transition(plan, rollback); }
      catch (error) {
        // Only failures known to happen before a mutation may safely reset state.
        const definitelyNotApplied = error instanceof ChangeError && ['ROW_CONFLICT','SCHEMA_CHANGED','TRIGGERS_UNSUPPORTED','TRIGGER_VISIBILITY_REQUIRED','FOREIGN_KEYS_UNSUPPORTED','INNODB_REQUIRED','COLUMN_TYPE_UNSUPPORTED','EXPECTED_ONE_ROW','ROLLBACK_EXPIRED','KEY_NOT_FOUND','MUTATION_REJECTED','CONNECTION_FAILED'].includes(error.code);
        this.ledger.finish(id, definitelyNotApplied ? (rollback ? 'applied' : 'prepared') : 'unknown', plan.outcome);
        throw definitelyNotApplied ? error : new ChangeError('OUTCOME_UNKNOWN');
      }
      const state = rollback ? 'rolled_back' : 'applied';
      try { this.ledger.finish(id, state, result); }
      catch { throw new ChangeError('OUTCOME_UNKNOWN'); }
      return { id, state, replayed: false, affectedRows: 1 };
    }, id);
  }
}
