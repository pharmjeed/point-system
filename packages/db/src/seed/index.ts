// Deterministic development/test seed — PNT-010, content = docs/17_Test_Acceptance_Plan.md §4.
//
// * Idempotent: every row has a fixed id and is written with INSERT … ON CONFLICT (id) DO NOTHING,
//   so a second run inserts nothing and changes nothing. A row that collides on another unique key
//   (same phone, a second active channel, a second open shift …) fails loudly instead of being skipped.
// * One transaction, serialised by an advisory lock; a failure leaves the database untouched.
// * Refuses to run when APP_ENV is production/staging or NODE_ENV is production, and when the
//   database already holds a live WhatsApp channel.
import { argon2id, hash } from 'argon2';
import type { ClientBase, Pool, PoolClient } from 'pg';
import { encryptField, resolveDataKey } from './crypto.js';
import { SEED_CREDENTIALS } from './credentials.js';
import {
  SEED_CUSTOMERS,
  SEED_EVENT_DATE,
  SEED_EVENTS,
  SEED_KEY_BOARDS,
  SEED_NOW,
  SEED_ORG,
  SEED_SHIFTS,
  SEED_USERS,
  SEED_VENUES,
  SEED_WHATSAPP_CHANNEL,
  SEED_ZONES,
  type SeedTable,
} from './fixtures.js';
import { SEED_IDS, seedKeySlotId, seedSpotId, seedSpotLabel } from './ids.js';

export * from './ids.js';
export * from './fixtures.js';
export * from './credentials.js';
export { DEV_DATA_ENCRYPTION_KEY, DEV_DATA_ENCRYPTION_KEY_ID, decryptField, encryptField } from './crypto.js';

/** argon2id parameters for seeded PINs/passwords (09 §9.1: ≥ 19 MiB, 2 iterations, parallelism 1). */
export const SEED_ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** APP_ENV values the seed refuses (06 ERD §9.4: never in staging or production). */
export const SEED_REFUSED_APP_ENVS: readonly string[] = ['production', 'prod', 'staging'];

export class SeedRefusedError extends Error {
  override name = 'SeedRefusedError';
}

export interface SeedOptions {
  /** Environment name; defaults to process.env.APP_ENV. */
  env?: string;
  /** Defaults to process.env.NODE_ENV; `production` is refused. */
  nodeEnv?: string;
  /** base64 of 32 bytes; defaults to process.env.DATA_ENCRYPTION_KEY, then the dev-only key. */
  dataEncryptionKey?: string;
  /** Defaults to process.env.DATA_ENCRYPTION_KEY_ID. */
  dataEncryptionKeyId?: string;
  /** Optional argon2 `secret` (pepper, 09 §9.1); defaults to process.env.AUTH_SECRET_PEPPER (proposed name). */
  secretPepper?: string;
  /** whatsapp_channel.display_name; defaults to process.env.BRAND_CUSTOMER_NAME_AR, else the schema default. */
  customerBrandNameAr?: string;
}

export interface SeedSummary {
  appEnv: string;
  tables: Record<SeedTable, { inserted: number; existing: number }>;
  /** Key id written into users.mfa_secret_enc. */
  dataKeyId: string;
  usedDevDataKey: boolean;
  pepperApplied: boolean;
}

/** Throws SeedRefusedError for production/staging. Exported so callers can check before connecting. */
export function assertSeedAllowed(appEnv: string | undefined, nodeEnv: string | undefined): void {
  const app = appEnv?.trim().toLowerCase() ?? '';
  if (SEED_REFUSED_APP_ENVS.includes(app)) {
    throw new SeedRefusedError(
      `seed refused: APP_ENV=${app} (the dev/test seed never runs in staging or production)`,
    );
  }
  if (nodeEnv?.trim().toLowerCase() === 'production') {
    throw new SeedRefusedError('seed refused: NODE_ENV=production');
  }
}

type Row = Record<string, unknown>;
type Conn = ClientBase | PoolClient;

function isPool(client: ClientBase | Pool): client is Pool {
  return 'totalCount' in client && 'idleCount' in client;
}

/** Multi-row INSERT … ON CONFLICT (id) DO NOTHING; returns the number of rows actually inserted. */
async function insertRows(conn: Conn, table: string, rows: readonly Row[]): Promise<number> {
  const first = rows[0];
  if (!first) return 0;
  const columns = Object.keys(first);
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const keys = Object.keys(row);
    if (keys.length !== columns.length || keys.some((k, i) => k !== columns[i])) {
      throw new Error(`seed: rows for ${table} must share the same columns`);
    }
    return `(${columns.map((c) => (values.push(row[c]), `$${values.length}`)).join(', ')})`;
  });
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (id) DO NOTHING`;
  const res = await conn.query(sql, values);
  return res.rowCount ?? 0;
}

const stamps = { created_at: SEED_NOW, updated_at: SEED_NOW };

function venueId(code: 'RMS' | 'LYL'): string {
  return SEED_IDS.venues[code];
}

/**
 * Seeds the development/test data of docs/17 §4 into a migrated database.
 * Do not call it inside an open transaction: it manages its own BEGIN/COMMIT.
 */
export async function seed(client: ClientBase | Pool, opts: SeedOptions = {}): Promise<SeedSummary> {
  const appEnv = (opts.env ?? process.env.APP_ENV ?? 'local').trim() || 'local';
  assertSeedAllowed(appEnv, opts.nodeEnv ?? process.env.NODE_ENV);

  const dataKey = resolveDataKey(
    {
      key: opts.dataEncryptionKey ?? process.env.DATA_ENCRYPTION_KEY,
      keyId: opts.dataEncryptionKeyId ?? process.env.DATA_ENCRYPTION_KEY_ID,
    },
    true, // non-production only (asserted above)
  );
  const pepper = opts.secretPepper ?? process.env.AUTH_SECRET_PEPPER ?? '';
  const brand = (opts.customerBrandNameAr ?? process.env.BRAND_CUSTOMER_NAME_AR ?? '').trim();

  const conn: Conn = isPool(client) ? await client.connect() : client;
  let failure: Error | undefined;
  const tables = {} as SeedSummary['tables'];
  const put = async (table: SeedTable, rows: readonly Row[]): Promise<void> => {
    const inserted = await insertRows(conn, table, rows);
    tables[table] = { inserted, existing: rows.length - inserted };
  };

  try {
    await conn.query('BEGIN');
    await conn.query("SELECT pg_advisory_xact_lock(hashtext('point.db.seed'))");
    const live = await conn.query("SELECT 1 FROM whatsapp_channel WHERE mode = 'live' LIMIT 1");
    if ((live.rowCount ?? 0) > 0) {
      throw new SeedRefusedError('seed refused: the database holds a live WhatsApp channel');
    }

    const org = SEED_ORG.id;
    const owner = SEED_IDS.users.OWN1;
    const admin = SEED_IDS.users.ADM1;

    await put('organizations', [{ id: org, name_ar: SEED_ORG.nameAr, name_en: SEED_ORG.nameEn, ...stamps }]);

    await put(
      'venues',
      SEED_VENUES.map((v) => ({
        id: v.id,
        org_id: org,
        code: v.code,
        name_ar: v.nameAr,
        name_en: v.nameEn,
        timezone: 'Asia/Riyadh',
        status: 'active',
        version: 1,
        ...stamps,
      })),
    );

    await put(
      'dispatch_pools',
      SEED_VENUES.map((v) => ({
        id: v.pool.id,
        org_id: org,
        venue_id: v.id,
        name: v.pool.name,
        is_default: true,
        status: 'active',
        ...stamps,
      })),
    );

    // Users: hash/encrypt only the accounts that do not exist yet (argon2 is deliberately slow).
    const present = await conn.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
      SEED_USERS.map((u) => u.id),
    ]);
    const presentIds = new Set(present.rows.map((r) => r.id));
    const missing = SEED_USERS.filter((u) => !presentIds.has(u.id));
    const hashOptions = pepper
      ? { ...SEED_ARGON2_OPTIONS, secret: Buffer.from(pepper, 'utf8') }
      : SEED_ARGON2_OPTIONS;
    const userRows = await Promise.all(
      missing.map(async (u): Promise<Row> => {
        const cred = SEED_CREDENTIALS[u.key];
        return {
          id: u.id,
          org_id: org,
          employee_code: u.employeeCode,
          full_name: u.fullName,
          phone_e164: u.phone,
          role: u.role,
          can_drive: u.canDrive,
          status: 'active',
          secret_kind: cred.secretKind,
          secret_hash: await hash(cred.secret, hashOptions),
          must_change_secret: false,
          mfa_enabled: u.mfaEnabled,
          mfa_secret_enc: u.mfaEnabled && cred.totpSecret ? encryptField(cred.totpSecret, dataKey) : null,
          created_by: u.key === 'OWN1' ? null : owner,
          version: 1,
          ...stamps,
        };
      }),
    );
    // The owner first: every other seeded account is created_by OWN1.
    const ownerRows = userRows.filter((r) => r.id === owner);
    const otherRows = userRows.filter((r) => r.id !== owner);
    const insertedOwner = await insertRows(conn, 'users', ownerRows);
    const insertedOthers = await insertRows(conn, 'users', otherRows);
    tables.users = {
      inserted: insertedOwner + insertedOthers,
      existing: SEED_USERS.length - insertedOwner - insertedOthers,
    };

    const scopeIds = SEED_IDS.roleScopes as Record<string, Record<string, string>>;
    await put(
      'role_scopes',
      SEED_USERS.flatMap((u) =>
        u.scopes.map((scope) => {
          const id = scopeIds[u.key]?.[scope];
          if (!id) throw new Error(`seed: no role scope id for ${u.key}/${scope}`);
          return {
            id,
            org_id: org,
            user_id: u.id,
            scope_type: scope === 'org' ? 'org' : 'venue',
            venue_id: scope === 'org' ? null : venueId(scope),
            granted_by: u.key === 'OWN1' ? null : owner,
            granted_at: SEED_NOW,
          };
        }),
      ),
    );

    await put(
      'driver_assignments',
      SEED_USERS.filter((u) => u.role === 'driver').map((u) => {
        if (!u.assignmentVenue) throw new Error(`seed: driver ${u.key} has no assignment venue`);
        return {
          id: SEED_IDS.assignments[u.key as keyof typeof SEED_IDS.assignments],
          org_id: org,
          driver_id: u.id,
          venue_id: venueId(u.assignmentVenue),
          status: 'active',
          starts_at: SEED_NOW,
          created_by: admin,
          ...stamps,
        };
      }),
    );

    await put(
      'events',
      SEED_EVENTS.map((e) => ({
        id: e.id,
        org_id: org,
        venue_id: venueId(e.venue),
        dispatch_pool_id: SEED_IDS.defaultPoolByVenue[e.venue],
        name_ar: e.nameAr,
        event_date: SEED_EVENT_DATE,
        starts_at: SEED_NOW,
        status: 'open',
        pricing_mode: e.pricingMode,
        fee_halalas: e.feeHalalas,
        allowed_payment_methods: [...e.allowedPaymentMethods],
        next_display_number: 1,
        opened_at: SEED_NOW,
        opened_by: admin,
        created_by: admin,
        version: 1,
        ...stamps,
      })),
    );

    await put(
      'shifts',
      SEED_SHIFTS.map((s) => ({
        id: s.id,
        org_id: org,
        venue_id: venueId(s.venue),
        dispatch_pool_id: SEED_IDS.defaultPoolByVenue[s.venue],
        name: s.name,
        starts_at: SEED_NOW,
        status: 'open',
        opened_at: SEED_NOW,
        opened_by: admin,
        created_by: admin,
        version: 1,
        ...stamps,
      })),
    );

    await put(
      'customers',
      SEED_CUSTOMERS.map((c) => ({
        id: c.id,
        org_id: org,
        phone_e164: c.phone,
        wa_id: c.waId,
        locale: 'ar',
        ...stamps,
      })),
    );

    await put(
      'parking_zones',
      SEED_ZONES.map((z) => ({
        id: z.id,
        org_id: org,
        venue_id: venueId(z.venue),
        name: z.name,
        sort_order: z.sortOrder,
        status: 'active',
        ...stamps,
      })),
    );

    await put(
      'parking_spots',
      SEED_ZONES.flatMap((z) =>
        Array.from({ length: z.spots }, (_, i) => {
          const label = seedSpotLabel(z.key, i + 1);
          return {
            id: seedSpotId(label),
            org_id: org,
            venue_id: venueId(z.venue),
            zone_id: z.id,
            label,
            status: 'active',
            ...stamps,
          };
        }),
      ),
    );

    await put(
      'key_boards',
      SEED_KEY_BOARDS.map((b) => ({
        id: b.id,
        org_id: org,
        venue_id: venueId(b.venue),
        name: b.name,
        status: 'active',
        ...stamps,
      })),
    );

    await put(
      'key_slots',
      SEED_KEY_BOARDS.flatMap((b) =>
        Array.from({ length: b.slots }, (_, i) => ({
          id: seedKeySlotId(b.venue, i + 1),
          org_id: org,
          venue_id: venueId(b.venue),
          key_board_id: b.id,
          label: String(i + 1),
          status: 'active',
          ...stamps,
        })),
      ),
    );

    const ch = SEED_WHATSAPP_CHANNEL;
    await put('whatsapp_channel', [
      {
        id: ch.id,
        org_id: org,
        ...(brand ? { display_name: brand } : {}),
        business_account_id: ch.businessAccountId,
        phone_number_id: ch.phoneNumberId,
        access_token_secret_ref: ch.accessTokenSecretRef,
        app_secret_ref: ch.appSecretRef,
        verify_token_secret_ref: ch.verifyTokenSecretRef,
        api_version: ch.apiVersion,
        mode: ch.mode,
        is_active: true,
        health_status: 'healthy',
        ...stamps,
      },
    ]);

    await conn.query('COMMIT');
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
    await conn.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    // A pooled connection that failed mid-seed is destroyed instead of being returned to the pool.
    if (isPool(client)) (conn as PoolClient).release(failure);
  }

  return {
    appEnv,
    tables,
    dataKeyId: dataKey.id,
    usedDevDataKey: dataKey.isDevFallback,
    pepperApplied: !!pepper,
  };
}
