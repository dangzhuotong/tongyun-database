import { createHash, randomUUID } from 'node:crypto';
import { ChangeError } from '../change-control/core.mjs';
import { requireValue } from './store.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class RemoteLedger {
  constructor(core) {
    this.core = core;
    core.db.exec(`CREATE TABLE IF NOT EXISTS _tongyun_remote_plans (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
      task_id TEXT NOT NULL, connection_id TEXT NOT NULL, environment TEXT NOT NULL,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS _tongyun_remote_plans_context ON _tongyun_remote_plans(task_id,connection_id,environment);`);
    core.db.exec('CREATE TABLE IF NOT EXISTS _tongyun_remote_requests(operation_id TEXT PRIMARY KEY,context TEXT NOT NULL,payload TEXT NOT NULL)');
  }
  event(event) { this.core.atomic(() => this.core.append(event)); }
  async track(action, fn, planId = null, request = undefined) {
    const operationId = randomUUID();
    this.core.atomic(()=>{
      this.core.append({ operationId, action, planId, outcome: 'started' });
      if(request!==undefined)this.core.db.prepare('INSERT INTO _tongyun_remote_requests VALUES (?,?,?)').run(operationId,JSON.stringify(this.core.context),JSON.stringify(request));
    });
    try {
      const result = await fn(operationId);
      this.event({ operationId, action, planId: result?.id ?? planId, outcome: 'succeeded' });
      return { operationId, ...result };
    } catch (error) {
      const code = error instanceof ChangeError ? error.code : 'REMOTE_ERROR';
      this.event({ operationId, action, planId, outcome: code === 'QUERY_CANCELLED' ? 'cancelled' : 'failed', code });
      throw error instanceof ChangeError ? error : new ChangeError('REMOTE_ERROR');
    }
  }
  save(payload) {
    const plan = { ...payload, id: randomUUID(), context: this.core.context, version: 1 };
    const hash = digest(plan);
    this.core.atomic(() => this.core.db.prepare("INSERT INTO _tongyun_remote_plans VALUES (?, ?, ?, 'prepared', ?, ?, ?, NULL)")
      .run(plan.id, hash, JSON.stringify(plan), plan.context.taskId, plan.context.connectionId, plan.context.environment));
    return { id: plan.id, digest: hash, state: 'prepared', affectedRows: 1 };
  }
  load(id) {
    const row = this.core.db.prepare('SELECT * FROM _tongyun_remote_plans WHERE id = ?').get(id);
    requireValue(row, 'PLAN_NOT_FOUND');
    const plan = JSON.parse(row.payload);
    requireValue(digest(plan) === row.digest, 'PLAN_TAMPERED');
    requireValue(['taskId', 'connectionId', 'environment'].every(k => plan.context[k] === this.core.context[k]), 'CONTEXT_MISMATCH');
    return { ...plan, digest: row.digest, state: row.state, outcome: row.outcome ? JSON.parse(row.outcome) : null };
  }
  inspectRequest(id) {
    const row=this.core.db.prepare('SELECT * FROM _tongyun_remote_requests WHERE operation_id=?').get(id);
    requireValue(row,'OPERATION_NOT_FOUND');const context=JSON.parse(row.context);
    requireValue(['taskId','connectionId','environment'].every(k=>context[k]===this.core.context[k]),'CONTEXT_MISMATCH');
    return {operationId:id,context,request:JSON.parse(row.payload)};
  }
  list() {
    return { plans: this.core.db.prepare('SELECT id,digest,state,payload FROM _tongyun_remote_plans WHERE task_id=? AND connection_id=? AND environment=? ORDER BY rowid DESC LIMIT 100')
      .all(this.core.context.taskId, this.core.context.connectionId, this.core.context.environment)
      .map(r => { const p = JSON.parse(r.payload); return { id: r.id, digest: r.digest, state: r.state, table: p.table ?? p.key, actor: p.context.actor, engine: p.engine }; }) };
  }
  begin(id, approvedDigest, rollback, connection) {
    return this.core.atomic(() => {
      const plan = this.load(id);
      requireValue(connection.allowWrites && connection.environment !== 'production', 'CONNECTION_READ_ONLY');
      requireValue(connection.revision === plan.connectionRevision, 'CONNECTION_CHANGED');
      requireValue(approvedDigest === plan.digest, 'APPROVAL_REQUIRED');
      const target = rollback ? 'rolled_back' : 'applied';
      if (plan.state === target) return { replayed: true, plan };
      requireValue(plan.state === (rollback ? 'applied' : 'prepared'), ['applying', 'rolling_back', 'unknown'].includes(plan.state) ? 'OUTCOME_UNKNOWN' : 'INVALID_STATE');
      this.core.append({ action: rollback ? 'approve_rollback' : 'approve_apply', planId: id, digest: plan.digest, outcome: 'recorded' });
      this.core.db.prepare('UPDATE _tongyun_remote_plans SET state=? WHERE id=?').run(rollback ? 'rolling_back' : 'applying', id);
      return { plan, replayed: false };
    });
  }
  finish(id, state, outcome = null) {
    this.core.atomic(() => {
      this.core.db.prepare('UPDATE _tongyun_remote_plans SET state=?, outcome=? WHERE id=?').run(state, outcome ? JSON.stringify(outcome) : null, id);
      this.core.append({ action: 'remote_result', planId: id, outcome: state === 'unknown' ? 'failed' : 'succeeded', state });
    });
  }
}
