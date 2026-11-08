/**
 * CSV for the exports (13 §13): RFC 4180 quoting, CRLF line ends, UTF-8 with a BOM so Excel opens Arabic text.
 * Free-text cells that start with a spreadsheet formula character are prefixed with `'` (CSV injection);
 * numbers and amounts are written as they are.
 */
export type CsvCell = string | number | boolean | null | undefined;

export interface CsvColumn<R> {
  name: string;
  value: (row: R) => CsvCell;
  /** user-entered text: guarded against formula injection */
  text?: boolean;
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell, text = false): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (text && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const BOM = '\uFEFF';

export function toCsv<R>(columns: readonly CsvColumn<R>[], rows: readonly R[]): string {
  const lines = [columns.map((c) => csvCell(c.name)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r), c.text)).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}
