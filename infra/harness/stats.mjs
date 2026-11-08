// Small statistics helpers for the run reports (nearest-rank percentiles, millisecond formatting).

/** Nearest-rank percentile of `values` (p in 0..100); null for an empty list. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.min(xs.length, Math.max(1, Math.ceil((p / 100) * xs.length)));
  return xs[rank - 1];
}

/** count, min, p50, p95, p99, max of a list of numbers. */
export function summary(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  return {
    count: xs.length,
    min: xs.length ? Math.min(...xs) : null,
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
    max: xs.length ? Math.max(...xs) : null,
  };
}

export const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);

export function groupBy(items, key) {
  const out = new Map();
  for (const it of items) {
    const k = key(it);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(it);
  }
  return out;
}

/** Markdown table from rows (array of arrays) and a header. */
export function table(header, rows) {
  const line = (cells) => `| ${cells.map((c) => String(c ?? '—').replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
