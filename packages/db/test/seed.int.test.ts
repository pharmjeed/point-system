// PNT-010 — the dev/test seed equals docs/17 §4, is idempotent, refuses production, and keeps the invariants green.
// Needs TEST_DATABASE_URL: an admin connection able to CREATE/DROP DATABASE (Testcontainers or a local PostgreSQL 16).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verify } from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEV_DATA_ENCRYPTION_KEY,
  DEV_DATA_ENCRYPTION_KEY_ID,
  SEED_CREDENTIALS,
  SEED_IDS,
  SEED_TABLE_COUNTS,
  SEED_USERS,
  SeedRefusedError,
  decryptField,
  seed,
  seedKeySlotId,
  seedSpotId,
  type SeedOptions,
  type SeedSummary,
} from '../src/seed/index.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_URL)
  throw new Error('seed.int.test.ts needs TEST_DATABASE_URL (admin URL of a PostgreSQL 16 server)');

const docs = fileURLToPath(new URL('../../../docs/', import.meta.url));
const SCHEMA_SQL = readFileSync(`${docs}06_schema.sql`, 'utf8');
// The invariants script is psql-flavoured: drop meta-commands such as `\set ON_ERROR_STOP 1`.
const INVARIANTS_SQL = readFileSync(`${docs}06_schema_invariants_test.sql`, 'utf8')
  .split('\n')
  .filter((line) => !line.startsWith('\\'))
  .join('\n');

const TEST_KEY = randomBytes(32).toString('base64');
const TEST_KEY_ID = 'k-test';
const TEST_PEPPER = 'pepper-for-seed-test';
const BASE_OPTS: SeedOptions = {
  env: 'test',
  nodeEnv: 'test',
  dataEncryptionKey: TEST_KEY,
  dataEncryptionKeyId: TEST_KEY_ID,
  secretPepper: TEST_PEPPER,
  customerBrandNameAr: '',
};

// Literal expectations from 17 §4 (deliberately not derived from the seed's own constants).
const EXPECTED_COUNTS: Record<string, number> = {
  organizations: 1,
  venues: 2,
  dispatch_pools: 2,
  users: 13, // OWN1, ADM1, SUP-R, SUP-RL, SUP-RD, DRV1…DRV8
  role_scopes: 6, // OWN1 org, ADM1 org, SUP-R RMS, SUP-RL RMS+LYL, SUP-RD RMS
  driver_assignments: 8,
  events: 3,
  shifts: 2,
  customers: 3,
  parking_zones: 3,
  parking_spots: 80, // A 30 + B 30 + P1 20
  key_boards: 2,
  key_slots: 100, // 60 + 40
  whatsapp_channel: 1,
};

interface TestDb {
  name: string;
  url: string;
}
const created: TestDb[] = [];

async function adminQuery(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

async function createDb(prefix: string): Promise<TestDb> {
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  await adminQuery(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${name}`;
  const db = { name, url: url.toString() };
  created.push(db);
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query(SCHEMA_SQL); // first migration = docs/06_schema.sql verbatim
  } finally {
    await c.end();
  }
  return db;
}

async function connect(db: TestDb): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}

/** count + content hash of every base table, so "changes nothing" covers the whole database. */
async function snapshot(c: pg.Client): Promise<Record<string, string>> {
  const tables = await c.query<{ t: string }>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
  );
  const out: Record<string, string> = {};
  for (const { t } of tables.rows) {
    const r = await c.query<{ n: string; h: string }>(
      `SELECT count(*)::text AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
    );
    out[t] = `${r.rows[0]?.n}:${r.rows[0]?.h}`;
  }
  return out;
}

async function count(c: pg.Client, sql: string, params: unknown[] = []): Promise<number> {
  const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params);
  return Number(r.rows[0]?.n);
}

afterAll(async () => {
  for (const db of created) await adminQuery(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`);
});

describe('PNT-010 seed (docs/17 §4)', () => {
  let db: TestDb;
  let c: pg.Client;
  let first: SeedSummary;

  beforeAll(async () => {
    db = await createDb('seed_test');
    c = await connect(db);
    first = await seed(c, BASE_OPTS);
  });

  afterAll(async () => {
    await c?.end();
  });

  it('inserts exactly the rows of 17 §4, per table', async () => {
    expect(SEED_TABLE_COUNTS).toEqual(EXPECTED_COUNTS);
    for (const [table, n] of Object.entries(EXPECTED_COUNTS)) {
      expect(await count(c, `SELECT 1 FROM ${table}`), table).toBe(n);
      expect(first.tables[table as keyof typeof first.tables]).toEqual({ inserted: n, existing: 0 });
    }
    // Operational rows are created by the real commands (17 §4 builders), never by the seed.
    for (const table of [
      'tickets',
      'duty_sessions',
      'tasks',
      'whatsapp_templates',
      'audit_log',
      'outbox_events',
    ]) {
      expect(await count(c, `SELECT 1 FROM ${table}`), table).toBe(0);
    }
  });

  it('organization, venues and one default pool per venue', async () => {
    const org = await c.query('SELECT name_ar FROM organizations WHERE id = $1', [SEED_IDS.org]);
    expect(org.rows).toEqual([{ name_ar: 'مؤسسة الفاليت التجريبية' }]);
    const venues = await c.query('SELECT id, code, name_ar, status FROM venues ORDER BY code');
    expect(venues.rows).toEqual([
      { id: SEED_IDS.venues.LYL, code: 'LYL', name_ar: 'قاعة ليلتي', status: 'active' },
      { id: SEED_IDS.venues.RMS, code: 'RMS', name_ar: 'قاعة ريماس', status: 'active' },
    ]);
    const pools = await c.query('SELECT id, venue_id FROM dispatch_pools WHERE is_default ORDER BY id');
    expect(pools.rows).toEqual([
      { id: SEED_IDS.pools['POOL-R'], venue_id: SEED_IDS.venues.RMS },
      { id: SEED_IDS.pools['POOL-L'], venue_id: SEED_IDS.venues.LYL },
    ]);
  });

  it('parking zones/spots and key boards/slots', async () => {
    const spots = await c.query<{ venue: string; zone: string; labels: string[] }>(
      `SELECT v.code AS venue, z.name AS zone, array_agg(s.label ORDER BY s.label) AS labels
         FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id JOIN venues v ON v.id = s.venue_id
        WHERE z.venue_id = s.venue_id GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    const labels = (p: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${p}-${String(i + 1).padStart(2, '0')}`);
    expect(spots.rows).toEqual([
      { venue: 'LYL', zone: 'P1', labels: labels('P1', 20) },
      { venue: 'RMS', zone: 'A', labels: labels('A', 30) },
      { venue: 'RMS', zone: 'B', labels: labels('B', 30) },
    ]);
    const spot = await c.query('SELECT label, zone_id FROM parking_spots WHERE id = $1', [
      seedSpotId('B-14'),
    ]);
    expect(spot.rows).toEqual([{ label: 'B-14', zone_id: SEED_IDS.zones.RMS.B }]);

    const slots = await c.query<{ venue: string; board: string; labels: string[] }>(
      `SELECT v.code AS venue, b.name AS board, array_agg(k.label ORDER BY k.label::int) AS labels
         FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id JOIN venues v ON v.id = k.venue_id
        WHERE b.venue_id = k.venue_id GROUP BY 1, 2 ORDER BY 1`,
    );
    const nums = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
    expect(slots.rows).toEqual([
      { venue: 'LYL', board: 'لوحة 1', labels: nums(40) },
      { venue: 'RMS', board: 'لوحة 1', labels: nums(60) },
    ]);
    const slot = await c.query('SELECT label, key_board_id FROM key_slots WHERE id = $1', [
      seedKeySlotId('LYL', 40),
    ]);
    expect(slot.rows).toEqual([{ label: '40', key_board_id: SEED_IDS.keyBoards.LYL }]);
  });

  it('users, roles, MFA, can_drive and scopes', async () => {
    const users = await c.query<{
      id: string;
      role: string;
      can_drive: boolean;
      mfa_enabled: boolean;
      has_mfa_secret: boolean;
      secret_kind: string;
      status: string;
    }>(
      `SELECT id, role, can_drive, mfa_enabled, mfa_secret_enc IS NOT NULL AS has_mfa_secret, secret_kind, status
         FROM users ORDER BY id`,
    );
    const byId = new Map(users.rows.map((u) => [u.id, u]));
    const expectUser = (key: keyof typeof SEED_IDS.users, role: string, mfa: boolean, canDrive = false) =>
      expect(byId.get(SEED_IDS.users[key]), key).toMatchObject({
        role,
        mfa_enabled: mfa,
        has_mfa_secret: mfa,
        can_drive: canDrive,
        secret_kind: role === 'driver' ? 'pin' : 'password',
        status: 'active',
      });
    expectUser('OWN1', 'owner', true);
    expectUser('ADM1', 'admin', true);
    expectUser('SUP-R', 'supervisor', false);
    expectUser('SUP-RL', 'supervisor', false);
    expectUser('SUP-RD', 'supervisor', false, true);
    for (let i = 1; i <= 8; i++) expectUser(`DRV${i}` as keyof typeof SEED_IDS.users, 'driver', false);

    const scopes = await c.query<{ user_id: string; scopes: string[] }>(
      `SELECT r.user_id, array_agg(coalesce(v.code, r.scope_type) ORDER BY coalesce(v.code, r.scope_type)) AS scopes
         FROM role_scopes r LEFT JOIN venues v ON v.id = r.venue_id WHERE r.revoked_at IS NULL GROUP BY 1`,
    );
    const scopeOf = new Map(scopes.rows.map((r) => [r.user_id, r.scopes]));
    expect(scopeOf.get(SEED_IDS.users.OWN1)).toEqual(['org']);
    expect(scopeOf.get(SEED_IDS.users.ADM1)).toEqual(['org']);
    expect(scopeOf.get(SEED_IDS.users['SUP-R'])).toEqual(['RMS']);
    expect(scopeOf.get(SEED_IDS.users['SUP-RL'])).toEqual(['LYL', 'RMS']);
    expect(scopeOf.get(SEED_IDS.users['SUP-RD'])).toEqual(['RMS']);
    expect(scopes.rows).toHaveLength(5);

    const assignments = await c.query<{ driver_id: string; venue_id: string }>(
      "SELECT driver_id, venue_id FROM driver_assignments WHERE status = 'active'",
    );
    const venueOf = new Map(assignments.rows.map((a) => [a.driver_id, a.venue_id]));
    for (let i = 1; i <= 8; i++) {
      const key = `DRV${i}` as keyof typeof SEED_IDS.users;
      expect(venueOf.get(SEED_IDS.users[key]), key).toBe(i <= 6 ? SEED_IDS.venues.RMS : SEED_IDS.venues.LYL);
    }
  });

  it('events, shifts, customers and the WhatsApp channel', async () => {
    const events = await c.query(
      `SELECT id, venue_id, dispatch_pool_id, status, pricing_mode, fee_halalas::int AS fee, allowed_payment_methods AS methods,
              next_display_number FROM events ORDER BY id`,
    );
    const common = { status: 'open', next_display_number: 1 };
    expect(events.rows).toEqual([
      {
        ...common,
        id: SEED_IDS.events['EVT-R1'],
        venue_id: SEED_IDS.venues.RMS,
        dispatch_pool_id: SEED_IDS.pools['POOL-R'],
        pricing_mode: 'included',
        fee: 0,
        methods: ['cash', 'pos'],
      },
      {
        ...common,
        id: SEED_IDS.events['EVT-R2'],
        venue_id: SEED_IDS.venues.RMS,
        dispatch_pool_id: SEED_IDS.pools['POOL-R'],
        pricing_mode: 'per_vehicle',
        fee: 2000,
        methods: ['cash', 'pos'],
      },
      {
        ...common,
        id: SEED_IDS.events['EVT-L1'],
        venue_id: SEED_IDS.venues.LYL,
        dispatch_pool_id: SEED_IDS.pools['POOL-L'],
        pricing_mode: 'included',
        fee: 0,
        methods: ['cash', 'pos'],
      },
    ]);

    const shifts = await c.query("SELECT id, dispatch_pool_id FROM shifts WHERE status = 'open' ORDER BY id");
    expect(shifts.rows).toEqual([
      { id: SEED_IDS.shifts['SHF-R'], dispatch_pool_id: SEED_IDS.pools['POOL-R'] },
      { id: SEED_IDS.shifts['SHF-L'], dispatch_pool_id: SEED_IDS.pools['POOL-L'] },
    ]);

    const customers = await c.query('SELECT id, phone_e164, wa_id FROM customers ORDER BY id');
    expect(customers.rows).toEqual([
      { id: SEED_IDS.customers.CUS1, phone_e164: '+966551234567', wa_id: '966551234567' },
      { id: SEED_IDS.customers.CUS2, phone_e164: '+966559876543', wa_id: '966559876543' },
      { id: SEED_IDS.customers.CUS3, phone_e164: '+966500001234', wa_id: '966500001234' },
    ]);

    const channel = await c.query('SELECT * FROM whatsapp_channel WHERE is_active');
    expect(channel.rows).toHaveLength(1);
    expect(channel.rows[0]).toMatchObject({
      id: SEED_IDS.whatsappChannel,
      org_id: SEED_IDS.org,
      mode: 'simulator',
      phone_number_id: 'SIM-PHONE',
      health_status: 'healthy',
    });
    // Secret columns are references, never values.
    for (const col of ['access_token_secret_ref', 'app_secret_ref', 'verify_token_secret_ref']) {
      expect(channel.rows[0][col]).toMatch(/^env:\/\/WA_[A-Z_]+$/);
    }
  });

  it('seeded PINs/passwords verify with argon2id (+ pepper) and MFA secrets decrypt', async () => {
    const rows = await c.query<{
      id: string;
      phone_e164: string;
      secret_hash: string;
      mfa_secret_enc: string | null;
    }>('SELECT id, phone_e164, secret_hash, mfa_secret_enc FROM users');
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    const pepper = { secret: Buffer.from(TEST_PEPPER, 'utf8') };
    const keys = new Map([[TEST_KEY_ID, Buffer.from(TEST_KEY, 'base64')]]);
    for (const u of SEED_USERS) {
      const row = byId.get(u.id);
      const cred = SEED_CREDENTIALS[u.key];
      expect(row?.phone_e164, u.key).toBe(cred.phone);
      expect(row?.secret_hash, u.key).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
      expect(await verify(row!.secret_hash, cred.secret, pepper), u.key).toBe(true);
      expect(await verify(row!.secret_hash, `${cred.secret}x`, pepper), u.key).toBe(false);
      if (cred.secretKind === 'pin') expect(cred.secret).toMatch(/^\d{6}$/);
      else expect(cred.secret.length).toBeGreaterThanOrEqual(12);
      if (cred.totpSecret) {
        expect(row?.mfa_secret_enc).toMatch(
          new RegExp(`^${TEST_KEY_ID}:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`),
        );
        expect(decryptField(row!.mfa_secret_enc!, keys)).toBe(cred.totpSecret);
        expect(cred.totpSecret).toMatch(/^[A-Z2-7]{32}$/); // 160-bit base32
      } else {
        expect(row?.mfa_secret_enc, u.key).toBeNull();
      }
    }
    // The pepper is really applied.
    const drv1 = byId.get(SEED_IDS.users.DRV1)!;
    expect(await verify(drv1.secret_hash, SEED_CREDENTIALS.DRV1.secret)).toBe(false);
  });

  it('a second run (through a Pool) inserts nothing and changes nothing', async () => {
    const before = await snapshot(c);
    const pool = new pg.Pool({ connectionString: db.url, max: 2 });
    let second: SeedSummary;
    try {
      second = await seed(pool, BASE_OPTS);
    } finally {
      await pool.end();
    }
    for (const [table, n] of Object.entries(EXPECTED_COUNTS)) {
      expect(second.tables[table as keyof typeof second.tables], table).toEqual({ inserted: 0, existing: n });
    }
    expect(await snapshot(c)).toEqual(before);
  });

  it('06_schema_invariants_test.sql still passes on the seeded database', async () => {
    const notices: string[] = [];
    const onNotice = (msg: { message?: string }) => notices.push(msg.message ?? '');
    c.on('notice', onNotice);
    try {
      const results = (await c.query(INVARIANTS_SQL)) as unknown as pg.QueryResult[];
      const last = results.at(-1);
      expect(Object.values(last?.rows[0] ?? {})).toEqual(['ALL INVARIANT TESTS PASSED']);
    } finally {
      c.off('notice', onNotice);
    }
    const expectedRejections = INVARIANTS_SQL.match(/SELECT expect_fail\(/g)?.length ?? 0;
    expect(expectedRejections).toBeGreaterThan(0);
    expect(notices.filter((n) => n.startsWith('ok (rejected)'))).toHaveLength(expectedRejections);
  });
});

describe('PNT-010 seed guards and defaults', () => {
  const untouchable = {
    query: () => {
      throw new Error('the database must not be touched');
    },
    connect: () => {
      throw new Error('the database must not be touched');
    },
  } as unknown as pg.Client;

  it.each([
    [{ env: 'production' }],
    [{ env: 'PRODUCTION' }],
    [{ env: 'staging' }],
    [{ env: 'local', nodeEnv: 'production' }],
  ])('refuses %j before touching the database', async (opts) => {
    await expect(seed(untouchable, { nodeEnv: 'test', ...opts })).rejects.toBeInstanceOf(SeedRefusedError);
  });

  it('reads APP_ENV / NODE_ENV from the environment by default', async () => {
    const saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
    try {
      process.env.APP_ENV = 'production';
      await expect(seed(untouchable)).rejects.toThrow(/APP_ENV=production/);
      process.env.APP_ENV = 'local';
      process.env.NODE_ENV = 'production';
      await expect(seed(untouchable)).rejects.toThrow(/NODE_ENV=production/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('refuses a database that holds a live WhatsApp channel and writes nothing', async () => {
    const db = await createDb('seed_live');
    const c = await connect(db);
    try {
      const other = '00000000-0000-4000-8000-ffff00000001';
      await c.query("INSERT INTO organizations (id, name_ar) VALUES ($1, 'x')", [other]);
      await c.query(
        `INSERT INTO whatsapp_channel (org_id, business_account_id, phone_number_id, access_token_secret_ref, app_secret_ref,
                                       verify_token_secret_ref, api_version, mode)
         VALUES ($1, 'w', 'p', 'sm://a', 'sm://b', 'sm://c', 'v26.0', 'live')`,
        [other],
      );
      await expect(seed(c, BASE_OPTS)).rejects.toBeInstanceOf(SeedRefusedError);
      expect(await count(c, 'SELECT 1 FROM organizations')).toBe(1);
      expect(await count(c, 'SELECT 1 FROM users')).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('without DATA_ENCRYPTION_KEY uses the dev-only key; brand name comes from configuration', async () => {
    const db = await createDb('seed_devkey');
    const c = await connect(db);
    try {
      const summary = await seed(c, {
        env: 'local',
        nodeEnv: 'development',
        dataEncryptionKey: '',
        dataEncryptionKeyId: '',
        secretPepper: '',
        customerBrandNameAr: 'BRAND-FROM-ENV',
      });
      expect(summary).toMatchObject({
        usedDevDataKey: true,
        dataKeyId: DEV_DATA_ENCRYPTION_KEY_ID,
        pepperApplied: false,
      });
      const own = await c.query<{ mfa_secret_enc: string; secret_hash: string }>(
        'SELECT mfa_secret_enc, secret_hash FROM users WHERE id = $1',
        [SEED_IDS.users.OWN1],
      );
      const row = own.rows[0]!;
      expect(row.mfa_secret_enc.startsWith(`${DEV_DATA_ENCRYPTION_KEY_ID}:`)).toBe(true);
      const keys = new Map([[DEV_DATA_ENCRYPTION_KEY_ID, Buffer.from(DEV_DATA_ENCRYPTION_KEY, 'base64')]]);
      expect(decryptField(row.mfa_secret_enc, keys)).toBe(SEED_CREDENTIALS.OWN1.totpSecret);
      expect(await verify(row.secret_hash, SEED_CREDENTIALS.OWN1.secret)).toBe(true);
      const ch = await c.query('SELECT display_name FROM whatsapp_channel');
      expect(ch.rows).toEqual([{ display_name: 'BRAND-FROM-ENV' }]);
    } finally {
      await c.end();
    }
  });

  it('rejects a malformed DATA_ENCRYPTION_KEY', async () => {
    await expect(seed(untouchable, { ...BASE_OPTS, dataEncryptionKey: 'c2hvcnQ=' })).rejects.toThrow(
      /32 bytes/,
    );
    await expect(seed(untouchable, { ...BASE_OPTS, dataEncryptionKeyId: '' })).rejects.toThrow(/KEY_ID/);
  });
});
