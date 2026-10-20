import { ChangeError } from '../change-control/core.mjs';

export async function mapInChunks(items, size, signal, fn) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
    rows.push(...await fn(items.slice(index, index + size)));
    if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
  }
  return rows;
}
