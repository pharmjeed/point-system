/**
 * Daily schedule of job.retention_purge from RETENTION_PURGE_CRON_UTC (05 §8, default `0 2 * * *` =
 * 05:00 Asia/Riyadh, 04 §6.2). Only daily expressions are meaningful for a daily job: the minute and hour
 * fields accept `*`, numbers, ranges, steps and lists; day-of-month, month and day-of-week must be `*`.
 */
export interface DailyCron {
  minutes: number[];
  hours: number[];
}

function field(spec: string, min: number, max: number, name: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`invalid cron ${name} field: ${spec}`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === '*' ? min : Number(m[2]);
    const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to)
      throw new Error(`invalid cron ${name} field: ${spec}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseDailyCron(expr: string): DailyCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields: ${expr}`);
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (dom !== '*' || month !== '*' || dow !== '*')
    throw new Error(`job.retention_purge runs daily: day, month and weekday must be '*' (${expr})`);
  return { minutes: field(minute, 0, 59, 'minute'), hours: field(hour, 0, 23, 'hour') };
}

/** The first instant (UTC, whole minute) matching the cron strictly after `after`. */
export function nextCronRun(expr: string, after: Date): Date {
  const cron = parseDailyCron(expr);
  const base = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate());
  for (let day = 0; day < 2; day++) {
    for (const h of cron.hours) {
      for (const m of cron.minutes) {
        const t = base + day * 86_400_000 + h * 3_600_000 + m * 60_000;
        if (t > after.getTime()) return new Date(t);
      }
    }
  }
  throw new Error(`no run found for ${expr}`);
}

/** `retention:<YYYY-MM-DD>` (04 §6.6) — the UTC date of the run. */
export function retentionDedupeKey(runAt: Date): string {
  return `retention:${runAt.toISOString().slice(0, 10)}`;
}
