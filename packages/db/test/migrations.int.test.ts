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

/** The V2 customer tables of 0009_customer_accounts.sql (V2-010, docs/v2/03_Data_Model.md §3). */
const CUSTOMER_TABLES = [
  'customer_accounts',
  'customer_otp_challenges',
  'customer_account_sessions',
  'customer_account_consents',
  'customer_vehicles',
  'customer_idempotency_keys',
  'customer_audit_log',
  // 0010_customer_pass_and_app_intake.sql (V2-013, DEC-500)
  'customer_passes',
  // 0013_customer_visits_push.sql (V2-015 / V2-016, DEC-518, DEC-519)
  'customer_visit_ratings',
  'customer_push_messages',
];

/** The V2 online-payment tables of 0012_online_payments.sql (V2-020 / V2-021, docs/v2/03_Data_Model.md §4). */
const ONLINE_PAYMENT_TABLES = [
  'customer_payment_methods',
  'online_payments',
  'refunds',
  'gateway_webhook_events',
  'payment_reconciliation_runs',
  'platform_alerts',
];

/** The V2 subscription tables of 0016_subscriptions.sql (V2-030 / V2-031, docs/v2/03_Data_Model.md §4). */
const SUBSCRIPTION_TABLES = [
  'subscription_plans',
  'subscriptions',
  'subscription_vehicles',
  'subscription_periods',
];

/** The V5 invoicing and settlement tables of 0017_invoices_settlement.sql (V2-040 … V2-042, docs/v2/03 §5). */
const INVOICING_TABLES = [
  'invoice_series',
  'settlement_statements',
  'settlement_lines',
  'invoices',
  'invoice_provider_events',
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

  it('creates the 47 base tables of 06_schema.sql, the 6 platform tables of 0008 (V2-001), the 10 customer tables of 0009 (V2-010), 0010 (V2-013) and 0013 (V2-015/V2-016), the 6 online-payment tables of 0012 (V2-020), the 4 subscription tables of 0016 (V2-030 / V2-031) and the 5 invoicing tables of 0017 (V2-040)', async () => {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`,
    );
    expect(r.rows[0].n).toBe(
      47 +
        PLATFORM_TABLES.length +
        CUSTOMER_TABLES.length +
        ONLINE_PAYMENT_TABLES.length +
        SUBSCRIPTION_TABLES.length +
        INVOICING_TABLES.length,
    );
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
      '0009_customers_account_index.sql',
      '0010_tickets_customer_vehicle_index.sql',
      '0013_customer_visits_push_token_index.sql',
      '0014_visit_payments_live_index.sql',
      '0014_visit_payments_system_refund_index.sql',
      '0016_online_payments_subscription_index.sql',
      '0016_tickets_subscription_index.sql',
      '0018_customer_otp_wamid_index.sql',
    ]);
    for (const m of later) {
      const statements = m.sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .filter((s) => s.trim());
      expect(statements, m.name).toHaveLength(1);
      expect(statements[0], m.name).toMatch(/^\s*CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS /);
    }
    const r = await client.query<{ name: string; valid: boolean }>(
      `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ANY($1) ORDER BY c.relname`,
      [
        [
          'ix_alerts_manual_resolved',
          'ix_customer_otp_wamid',
          'ix_online_payments_subscription',
          'ix_online_payments_ticket_live',
          'ix_tickets_customer_vehicle_open',
          'ix_tickets_subscription',
          'ix_whatsapp_inbound_org_received',
          'ix_whatsapp_messages_accepted',
          'uq_customer_sessions_push_token',
          'uq_customers_org_account',
          'uq_refunds_system',
        ],
      ],
    );
    expect(r.rows).toEqual([
      { name: 'ix_alerts_manual_resolved', valid: true },
      { name: 'ix_customer_otp_wamid', valid: true },
      { name: 'ix_online_payments_subscription', valid: true },
      { name: 'ix_online_payments_ticket_live', valid: true },
      { name: 'ix_tickets_customer_vehicle_open', valid: true },
      { name: 'ix_tickets_subscription', valid: true },
      { name: 'ix_whatsapp_inbound_org_received', valid: true },
      { name: 'ix_whatsapp_messages_accepted', valid: true },
      { name: 'uq_customer_sessions_push_token', valid: true },
      { name: 'uq_customers_org_account', valid: true },
      { name: 'uq_refunds_system', valid: true },
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
    // V2-013 (DEC-501): the widening that supersedes a V1 check is itself checked
    ['widened CHECK constraint', 'ALTER TABLE tickets DROP CONSTRAINT ck_tickets_channel'],
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
    expect(checked).toBe(
      47 +
        PLATFORM_TABLES.length +
        CUSTOMER_TABLES.length +
        ONLINE_PAYMENT_TABLES.length +
        SUBSCRIPTION_TABLES.length +
        INVOICING_TABLES.length,
    );
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
        'customer_account_consents',
        'customer_audit_log',
      ]) {
        await client.query('SAVEPOINT s');
        const col =
          t === 'customer_account_consents'
            ? 'kind'
            : t.endsWith('_audit_log') && t !== 'audit_log'
              ? 'action'
              : 'org_id';
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

  it('V2-020: the app role never deletes an online-payment row, and a refund keeps its amount, reason and issuer', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE point_app');
      for (const t of [...ONLINE_PAYMENT_TABLES, ...SUBSCRIPTION_TABLES]) {
        await client.query('SAVEPOINT s');
        await expect(client.query(`DELETE FROM ${t} WHERE false`), t).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await client.query('ROLLBACK');
    }
    await client.query('BEGIN');
    try {
      const acc = await client.query<{ id: string }>(
        `INSERT INTO customer_accounts (phone_e164) VALUES ('+966500000977') RETURNING id`,
      );
      const pu = await client.query<{ id: string }>(
        `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash) VALUES ('+966500000978', 'x', 'platform_finance', 'x') RETURNING id`,
      );
      // V2-031 (0016): a subscription payment names its subscription, its venue and the period it pays
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (name_ar) VALUES ('مؤسسة') RETURNING id`,
      );
      const venue = await client.query<{ id: string }>(
        `INSERT INTO venues (org_id, code, name_ar) VALUES ($1, 'OFC', 'برج') RETURNING id`,
        [org.rows[0]!.id],
      );
      const plan = await client.query<{ id: string }>(
        `INSERT INTO subscription_plans (org_id, venue_id, name_ar, monthly_price_halalas, created_by)
         VALUES ($1, $2, 'سيارة واحدة', 2300, $3) RETURNING id`,
        [org.rows[0]!.id, venue.rows[0]!.id, pu.rows[0]!.id],
      );
      const sub = await client.query<{ id: string }>(
        `INSERT INTO subscriptions (account_id, plan_id, org_id, venue_id, billing_cycle, price_halalas, vehicles_included,
                                    pending_expires_at)
         VALUES ($1, $2, $3, $4, 'monthly', 2300, 1, now()) RETURNING id`,
        [acc.rows[0]!.id, plan.rows[0]!.id, org.rows[0]!.id, venue.rows[0]!.id],
      );
      const pay = await client.query<{ id: string }>(
        `INSERT INTO online_payments (account_id, purpose, subscription_id, subscription_period_seq, org_id, venue_id,
                                      amount_halalas, vat_halalas, gateway, given_id, gateway_payment_id, status, paid_at)
         VALUES ($1, 'subscription', $2, 1, $3, $4, 2300, 300, 'moyasar', gen_random_uuid(), 'pay-1', 'paid', now())
         RETURNING id`,
        [acc.rows[0]!.id, sub.rows[0]!.id, org.rows[0]!.id, venue.rows[0]!.id],
      );
      const ref = await client.query<{ id: string }>(
        `INSERT INTO refunds (online_payment_id, amount_halalas, reason, issued_by) VALUES ($1, 500, 'خطأ في السعر', $2) RETURNING id`,
        [pay.rows[0]!.id, pu.rows[0]!.id],
      );
      const id = ref.rows[0]!.id;
      await client.query('SAVEPOINT s');
      await expect(
        client.query(`UPDATE refunds SET amount_halalas = 900 WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT s');
      await client.query(`UPDATE refunds SET status = 'succeeded', completed_at = now() WHERE id = $1`, [id]);
      await expect(client.query(`UPDATE refunds SET status = 'failed' WHERE id = $1`, [id])).rejects.toThrow(
        /final/,
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('V2-040 / V2-041: nothing financial is deleted; the provider log is append-only; a line is released, never edited', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE point_app');
      for (const t of INVOICING_TABLES) {
        await client.query('SAVEPOINT s');
        await expect(client.query(`DELETE FROM ${t} WHERE false`), t).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
      await expect(
        client.query(`UPDATE invoice_provider_events SET outcome = outcome WHERE false`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK');
    }
    await client.query('BEGIN');
    try {
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (name_ar) VALUES ('مشغل التسوية') RETURNING id`,
      );
      const st = await client.query<{ id: string }>(
        `INSERT INTO settlement_statements (org_id, period_start, period_end) VALUES ($1, '2026-10-01', '2026-11-01') RETURNING id`,
        [org.rows[0]!.id],
      );
      const l = await client
        .query<{ id: string }>(
          `INSERT INTO settlement_lines (statement_id, org_id, kind, line_key, amount_halalas, occurred_on, note, created_by)
         VALUES ($1, $2, 'adjustment', 'adjustment:x1', -500, '2026-10-05', 'تسوية', NULL) RETURNING id`,
          [st.rows[0]!.id, org.rows[0]!.id],
        )
        .catch((e: Error) => e);
      // an adjustment names its platform user
      expect(l).toBeInstanceOf(Error);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      const org2 = await client.query<{ id: string }>(
        `INSERT INTO organizations (name_ar) VALUES ('مشغل التسوية') RETURNING id`,
      );
      const st2 = await client.query<{ id: string }>(
        `INSERT INTO settlement_statements (org_id, period_start, period_end, subscriber_visit_count, net_payable_halalas)
         VALUES ($1, '2026-10-01', '2026-11-01', 0, 0) RETURNING id`,
        [org2.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO settlement_lines (statement_id, org_id, kind, line_key, amount_halalas, occurred_on)
         VALUES ($1, $2, 'saas_fee', 'saas_fee:v1:2026-10:c1', -1000, '2026-10-01')`,
        [st2.rows[0]!.id, org2.rows[0]!.id],
      );
      await client.query('SAVEPOINT s');
      await expect(
        client.query(`UPDATE settlement_lines SET amount_halalas = -1 WHERE statement_id = $1`, [
          st2.rows[0]!.id,
        ]),
      ).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT s');
      // the header must equal its lines at COMMIT (deferred): here it says 0 while the line says −10.00
      await expect(client.query('COMMIT')).rejects.toThrow(/does not equal the sum of its lines/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  });
});
