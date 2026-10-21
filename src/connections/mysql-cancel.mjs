import { ChangeError } from '../change-control/core.mjs';
import { requireValue } from './store.mjs';

export async function killMysqlQuery(connect, threadId) {
  const id = Number(threadId);
  requireValue(Number.isInteger(id) && id > 0, 'INVALID_THREAD');
  const killer = await connect();
  try { await killer.promise().query(`KILL QUERY ${id}`); }
  finally { killer.destroy(); }
}

export function withMysqlCancel({ connect, threadId, signal, run }) {
  if (!signal) return Promise.resolve().then(run);
  let kill = null;
  const ensureKill = () => {
    kill ??= killMysqlQuery(connect, threadId).then(() => {}, () => {});
    return kill;
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      const done = () => { if (error) reject(error); else resolve(value); };
      // A read error can arrive before KILL QUERY returns. Wait for that attempt.
      if (signal.aborted || kill) ensureKill().then(done, done);
      else done();
    };
    const onAbort = () => {
      ensureKill().then(() => finish(new ChangeError('QUERY_CANCELLED')));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    Promise.resolve().then(run).then(value => {
      if (signal.aborted) onAbort();
      else finish(null, value);
    }).catch(error => {
      if (signal.aborted) onAbort();
      else finish(error instanceof ChangeError ? error : new ChangeError('QUERY_FAILED'));
    });
  });
}
