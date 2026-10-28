import pg from 'pg';

/**
 * A normalized snapshot of everything the invariants live in: tables/columns, constraints (incl. CHECK
 * expressions), indexes (incl. partial predicates), views, functions and triggers. Used by the drift check.
 */
export interface CatalogSnapshot {
  tables: string[];
  columns: string[];
  constraints: string[];
  indexes: string[];
  views: string[];
  triggers: string[];
  functions: string[];
}

const IGNORED_TABLES = new Set(['schema_migrations']);

export async function snapshotCatalog(client: pg.ClientBase): Promise<CatalogSnapshot> {
  const q = async (sql: string) => (await client.query<{ v: string }>(sql)).rows.map((r) => r.v);
  const keep = (rows: string[]) =>
    rows.filter((r) => ![...IGNORED_TABLES].some((t) => r.startsWith(t + ':') || r === t));
  return {
    tables: keep(await q(`SELECT tablename AS v FROM pg_tables WHERE schemaname='public' ORDER BY 1`)),
    columns: keep(
      await q(`SELECT table_name||':'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'')||':'||coalesce(is_identity,'') AS v
               FROM information_schema.columns WHERE table_schema='public' ORDER BY 1`),
    ),
    constraints: keep(
      await q(`SELECT c.conrelid::regclass::text||':'||c.conname||':'||pg_get_constraintdef(c.oid) AS v
               FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY 1`),
    ),
    indexes: keep(
      await q(
        `SELECT tablename||':'||indexname||':'||indexdef AS v FROM pg_indexes WHERE schemaname='public' ORDER BY 1`,
      ),
    ),
    views: await q(
      `SELECT viewname||':'||pg_get_viewdef(('public.'||viewname)::regclass, true) AS v FROM pg_views WHERE schemaname='public' ORDER BY 1`,
    ),
    triggers: await q(
      `SELECT tgrelid::regclass::text||':'||tgname||':'||pg_get_triggerdef(oid) AS v FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
    ),
    functions: await q(
      `SELECT p.proname||':'||pg_get_functiondef(p.oid) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`,
    ),
  };
}

export interface DriftReport {
  ok: boolean;
  missing: Record<string, string[]>;
  extra: Record<string, string[]>;
}

/** `expected` comes from docs/06_schema.sql, `actual` from the migrations. Anything missing is drift. */
export function compareCatalogs(expected: CatalogSnapshot, actual: CatalogSnapshot): DriftReport {
  const missing: Record<string, string[]> = {};
  const extra: Record<string, string[]> = {};
  for (const k of Object.keys(expected) as (keyof CatalogSnapshot)[]) {
    const a = new Set(actual[k]);
    const e = new Set(expected[k]);
    const m = expected[k].filter((x) => !a.has(x));
    const x = actual[k].filter((y) => !e.has(y));
    if (m.length) missing[k] = m;
    if (x.length) extra[k] = x;
  }
  return { ok: Object.keys(missing).length === 0, missing, extra };
}
