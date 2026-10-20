import { randomUUID } from 'node:crypto';
import { ChangeError } from '../change-control/core.mjs';

const QUERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const active = new Map();
const pendingCancel = new Map();

function sameContext(a, b) {
  return a.connectionId === b.connectionId && a.taskId === b.taskId && a.environment === b.environment;
}

export function normalizeQueryId(value) {
  if (value === undefined || value === null || value === '') return randomUUID();
  if (typeof value === 'string' && QUERY_ID.test(value)) return value.toLowerCase();
  throw new ChangeError('INVALID_QUERY_ID');
}

function prunePending() {
  const cutoff = Date.now() - 600000;
  for (const [id, entry] of pendingCancel) if (entry.at < cutoff) pendingCancel.delete(id);
  while (pendingCancel.size > 200) pendingCancel.delete(pendingCancel.keys().next().value);
}

export function beginQuery(queryId, context) {
  const id = normalizeQueryId(queryId);
  if (active.has(id)) throw new ChangeError('QUERY_ID_IN_USE');
  const controller = new AbortController();
  const pending = pendingCancel.get(id);
  if (pending) {
    pendingCancel.delete(id);
    if (!sameContext(pending.context, context)) throw new ChangeError('QUERY_NOT_FOUND');
    controller.abort();
  }
  active.set(id, { controller, context });
  return { queryId: id, controller };
}

export function prepareCancel(queryId, context) {
  const id = normalizeQueryId(queryId);
  const entry = active.get(id);
  if (entry && !sameContext(entry.context, context)) throw new ChangeError('QUERY_NOT_FOUND');
  return {
    queryId: id,
    status: 'cancelled',
    apply() {
      const current = active.get(id);
      if (current) current.controller.abort();
      else {
        prunePending();
        pendingCancel.set(id, { context, at: Date.now() });
      }
    },
  };
}

export function finishQuery(queryId) {
  active.delete(queryId);
}

export function resetQueries() {
  active.clear();
  pendingCancel.clear();
}
