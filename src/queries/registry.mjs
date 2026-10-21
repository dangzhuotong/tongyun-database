import { randomUUID } from 'node:crypto';
import { ChangeError } from '../change-control/core.mjs';

const QUERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const active = new Map();

function sameContext(a, b) {
  return a.connectionId === b.connectionId && a.taskId === b.taskId && a.environment === b.environment;
}

export function normalizeQueryId(value) {
  if (value === undefined || value === null || value === '') return randomUUID();
  if (typeof value === 'string' && QUERY_ID.test(value)) return value.toLowerCase();
  throw new ChangeError('INVALID_QUERY_ID');
}

export function beginQuery(queryId, context) {
  const id = normalizeQueryId(queryId);
  if (active.has(id)) throw new ChangeError('QUERY_ID_IN_USE');
  const controller = new AbortController();
  active.set(id, { controller, context });
  return { queryId: id, controller };
}

export function prepareCancel(queryId, context) {
  const id = normalizeQueryId(queryId);
  const entry = active.get(id);
  if (!entry) return { queryId: id, status: 'not_running' };
  if (!sameContext(entry.context, context)) throw new ChangeError('QUERY_NOT_FOUND');
  return {
    queryId: id,
    status: 'cancelled',
    apply() { active.get(id)?.controller.abort(); },
  };
}

export function finishQuery(queryId) {
  active.delete(queryId);
}

export function resetQueries() {
  active.clear();
}
