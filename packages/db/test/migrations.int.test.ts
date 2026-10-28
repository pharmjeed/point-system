import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareCatalogs, snapshotCatalog } from '../src/catalog.js';
import { migrate } from '../src/migrate.js';
import { SCHEMA_SQL } from '../src/paths.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { runInvariants, runSqlScript } from '../src/tools.js';
import * as tables from '../src/schema/schema.js';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

// PNT-003 / PNT-004 acceptance.
describe('migrations', () => {
  let db: TestDatabase;
  let ref: TestDatabase;
  let client: pg.Client;
  let refClient: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    ref = await createTestDatabase({ migrated: false });
    await runSqlScript(ref.url, SCHEMA_SQL);
    client = new pg.Client({ connectionString: db.url });
    refClient = new pg.Client({ connectionString: ref.url });
    await client.connect();
    await refClient.connect();
  });
  afterAll(async () => {
    await client.end();
    await refClient.end();
    await db.drop();
    await ref.drop();
  });

  it('creates the 47 base tables of 06_schema.sql', async () => {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`,
    );
    expect(r.rows[0].n).toBe(47);
  });

  it('the first migration is docs/06_schema.sql verbatim', () => {
    const first = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
    expect(first).toBe(readFileSync(SCHEMA_SQL, 'utf8'));
  });

  it('has no drift against docs/06_schema.sql (same indexes, checks, views, triggers)', async () => {
    const report = compareCatalogs(await snapshotCatalog(refClient), await snapshotCatalog(client));
    expect(report.missing).toEqual({});
    expect(report.ok).toBe(true);
  });

  it('re-running migrate is a no-op', async () => {
    expect(await migrate(db.url)).toEqual([]);
  });

  it.each([
    ['partial unique index', 'DROP INDEX uq_claim_codes_live'],
    ['CHECK constraint', 'ALTER TABLE users DROP CONSTRAINT ck_users_can_drive_supervisor_only'],
    ['view', 'DROP VIEW v_pool_queue'],
  ])('drift check fails when a %s is lost', async (_kind, ddl) => {
    const broken = await createTestDatabase();
    const c = new pg.Client({ connectionString: broken.url });
    await c.connect();
    try {
      await c.query(ddl);
      const report = compareCatalogs(await snapshotCatalog(refClient), await snapshotCatalog(c));
      expect(report.ok).toBe(false);
    } finally {
      await c.end();
      await broken.drop();
    }
  });

  it('Drizzle tables match the database column names literally', async () => {
    const cols = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname='public')`,
    );
    const dbCols = new Map<string, Set<string>>();
    for (const r of cols.rows) {
      if (!dbCols.has(r.table_name)) dbCols.set(r.table_name, new Set());
      dbCols.get(r.table_name)!.add(r.column_name);
    }
    let checked = 0;
    for (const t of Object.values(tables)) {
      if (!(t && typeof t === 'object' && Symbol.for('drizzle:IsDrizzleTable') in t)) continue;
      const cfg = getTableConfig(t as PgTable);
      const expected = dbCols.get(cfg.name);
      expect(expected, cfg.name).toBeDefined();
      expect(new Set(cfg.columns.map((c) => c.name))).toEqual(expected);
      checked++;
    }
    expect(checked).toBe(47);
  });

  it('runs docs/06_schema_invariants_test.sql green on the migrated schema', async () => {
    const r = await runInvariants(process.env.TEST_DATABASE_URL!);
    expect(r.output.at(-1)).toBe('ALL INVARIANT TESTS PASSED');
    expect(r.passed).toBe(true);
  });

  it('the app role cannot UPDATE or DELETE append-only tables (PNT-009)', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE point_app');
      for (const t of ['audit_log', 'ticket_events', 'custody_events', 'analytics_events']) {
        await client.query('SAVEPOINT s');
        await expect(client.query(`UPDATE ${t} SET org_id = org_id WHERE false`)).rejects.toThrow(
          /permission denied/,
        );
        await client.query('ROLLBACK TO SAVEPOINT s');
        await expect(client.query(`DELETE FROM ${t} WHERE false`)).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
