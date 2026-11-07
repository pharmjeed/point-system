import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareCatalogs, snapshotCatalog } from '../src/catalog.js';
import { listMigrations, migrate, refuseInvalidIndexes } from '../src/migrate.js';
import { SCHEMA_SQL } from '../src/paths.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { runInvariants, runSqlScript } from '../src/tools.js';
import * as tables from '../src/schema/schema.js';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

/** The V2 platform tables of 0008_platform.sql (V2-001, docs/v2/03_Data_Model.md §1–§2). */
const PLATFORM_TABLES = [
  'platform_users',
  'platform_sessions',
  'platform_idempotency_keys',
  'platform_audit_log',
  'operator_contracts',
  'venue_public_profiles',
];

/**
 * Corrections made to docs/06_schema.sql after v1.1 (0001 keeps the delivered file; migrations are append-only and
 * checksummed). Each pair is (text in 0001, text in docs/06_schema.sql); the migration applying it is named in the DEC.
 */
const SCHEMA_CORRECTIONS: [string, string][] = [
  [
    "CHECK (name ~ '^[a-z0-9_]{1,512}$'),   -- e.g. masaf_ticket_issued_v1",
    "CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512),   -- e.g. masaf_ticket_issued_v1 (DEC-129)",
  ],
];

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

  it('creates the 47 base tables of 06_schema.sql and the 6 platform tables of 0008 (V2-001)', async () => {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`,
    );
    expect(r.rows[0].n).toBe(47 + PLATFORM_TABLES.length);
    const ref = await refClient.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`,
    );
    expect(ref.rows[0].n).toBe(47);
  });

  it('the first migration is docs/06_schema.sql v1.1 verbatim; later corrections ship as migrations', () => {
    const first = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
    let corrected = first;
    for (const [from, to] of SCHEMA_CORRECTIONS) {
      expect(corrected.split(from).length - 1, from).toBe(1);
      corrected = corrected.replace(from, () => to); // a function: `to` contains `$'`
    }
    expect(corrected).toBe(readFileSync(SCHEMA_SQL, 'utf8'));
  });

  it('whatsapp_templates accepts a valid name and still rejects an invalid one (DEC-129)', async () => {
    await client.query('BEGIN');
    try {
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (name_ar) VALUES ('مؤسسة') RETURNING id`,
      );
      const insert = (name: string) =>
        client.query(
          `INSERT INTO whatsapp_templates (org_id, name, category, components) VALUES ($1, $2, 'UTILITY', '[]')`,
          [org.rows[0]!.id, name],
        );
      await insert('masaf_ticket_issued_v1');
      await client.query('SAVEPOINT bad');
      await expect(insert('Bad-Name')).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT bad');
      await expect(insert('x'.repeat(513))).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('has no drift against docs/06_schema.sql (same indexes, checks, views, triggers)', async () => {
    const report = compareCatalogs(await snapshotCatalog(refClient), await snapshotCatalog(client));
    expect(report.missing).toEqual({});
    expect(report.ok).toBe(true);
  });

  it('re-running migrate is a no-op', async () => {
    expect(await migrate(db.url)).toEqual([]);
  });

  it('later indexes are built CONCURRENTLY, one statement alone in its file, and end valid (06 ERD §9.2 rule 5)', async () => {
    // an index on a table the same migration creates is built on an empty table (0008, V2-001): rule 5 is about
    // the large live tables only
    const onLiveTable = (sql: string) => {
      const created = new Set([...sql.matchAll(/CREATE TABLE (\w+)/gi)].map((x) => x[1]));
      return [
        ...sql.matchAll(
          /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?\w+\s+ON\s+(\w+)/gi,
        ),
      ]
        .map((x) => x[1])
        .some((t) => !created.has(t));
    };
    const later = listMigrations().filter((m) => m.name >= '0005' && onLiveTable(m.sql));
    expect(later.map((m) => m.name)).toEqual([
      '0005_wa_quota_index.sql',
      '0006_wa_inbound_received_index.sql',
      '0007_alerts_manual_resolved_index.sql',
    ]);
    for (const m of later) {
      const statements = m.sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .filter((s) => s.trim());
      expect(statements, m.name).toHaveLength(1);
      expect(statements[0], m.name).toMatch(/^\s*CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
    }
    const r = await client.query<{ name: string; valid: boolean }>(
      `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ANY($1) ORDER BY c.relname`,
      [['ix_alerts_manual_resolved', 'ix_whatsapp_inbound_org_received', 'ix_whatsapp_messages_accepted']],
    );
    expect(r.rows).toEqual([
      { name: 'ix_alerts_manual_resolved', valid: true },
      { name: 'ix_whatsapp_inbound_org_received', valid: true },
      { name: 'ix_whatsapp_messages_accepted', valid: true },
    ]);
  });

  it('an interrupted concurrent build leaves an INVALID index, and no migration is recorded over it', async () => {
    const broken = await createTestDatabase();
    const c = new pg.Client({ connectionString: broken.url });
    await c.connect();
    try {
      await expect(refuseInvalidIndexes(c, '0005_wa_quota_index.sql')).resolves.toBeUndefined();
      // a unique build over duplicates fails half way and keeps its catalog entry, marked invalid
      await c.query(`CREATE TABLE scratch_dupes (v int)`);
      await c.query(`INSERT INTO scratch_dupes VALUES (1), (1)`);
      await expect(
        c.query(`CREATE UNIQUE INDEX CONCURRENTLY ix_scratch_dupes ON scratch_dupes (v)`),
      ).rejects.toMatchObject({
        code: '23505',
      });
      // IF NOT EXISTS now skips it: only the check stops the run
      await c.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ix_scratch_dupes ON scratch_dupes (v)`);
      await expect(refuseInvalidIndexes(c, '0009_x.sql')).rejects.toThrow(
        /Migration 0009_x\.sql left invalid indexes \(ix_scratch_dupes\)/,
      );
    } finally {
      await c.end();
      await broken.drop();
    }
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
    expect(checked).toBe(47 + PLATFORM_TABLES.length);
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
      for (const t of [
        'audit_log',
        'ticket_events',
        'custody_events',
        'analytics_events',
        'platform_audit_log',
      ]) {
        await client.query('SAVEPOINT s');
        const col = t === 'platform_audit_log' ? 'action' : 'org_id';
        await expect(client.query(`UPDATE ${t} SET ${col} = ${col} WHERE false`)).rejects.toThrow(
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
