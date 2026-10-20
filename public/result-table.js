const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function displayCell(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (value && typeof value === 'object' && '$integer' in value) return String(value.$integer);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

function integerLike(value) {
  if (typeof value === 'bigint') return value;
  if (value && typeof value === 'object' && '$integer' in value && INTEGER.test(String(value.$integer))) return BigInt(value.$integer);
  if (typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && INTEGER.test(value)) return BigInt(value);
  return null;
}

export function isNumberLike(value) {
  if (typeof value === 'bigint') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value && typeof value === 'object' && '$integer' in value) return INTEGER.test(String(value.$integer));
  return typeof value === 'string' && (INTEGER.test(value) || DECIMAL.test(value));
}

export function isDateLike(value) {
  return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value));
}

export function columnKind(values) {
  const present = (values ?? []).filter(value => !isEmpty(value));
  if (!present.length) return 'string';
  if (present.every(isNumberLike)) return 'number';
  if (present.every(isDateLike)) return 'date';
  return 'string';
}

function comparePresent(a, b, kind) {
  if (kind === 'number') {
    const ia = integerLike(a);
    const ib = integerLike(b);
    if (ia !== null && ib !== null) return ia < ib ? -1 : ia > ib ? 1 : 0;
    return Number(displayCell(a)) - Number(displayCell(b));
  }
  if (kind === 'date') return Date.parse(a) - Date.parse(b);
  return displayCell(a).localeCompare(displayCell(b), 'zh');
}

export function sortRows(rows, column, direction, kind) {
  const sign = direction === 'desc' ? -1 : 1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const av = a.row[column];
    const bv = b.row[column];
    const ae = isEmpty(av);
    const be = isEmpty(bv);
    if (ae || be) return ae === be ? a.index - b.index : ae ? 1 : -1;
    const compared = comparePresent(av, bv, kind);
    return compared === 0 ? a.index - b.index : sign * compared;
  }).map(item => item.row);
}

export function filterRows(rows, columns, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  const source = rows ?? [];
  if (!needle) return source.slice();
  return source.filter(row => (columns ?? []).some(column => displayCell(row?.[column]).toLowerCase().includes(needle)));
}

export function applyResultView(rows, columns, view = {}) {
  const filtered = filterRows(rows, columns, view.filter ?? '');
  if (!view.sortColumn || !(columns ?? []).includes(view.sortColumn)) return filtered;
  const kind = columnKind(filtered.map(row => row[view.sortColumn]));
  return sortRows(filtered, view.sortColumn, view.sortDirection === 'desc' ? 'desc' : 'asc', kind);
}
