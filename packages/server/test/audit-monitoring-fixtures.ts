import { SEED_IDS, seed } from '@point/db/seed';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/core/db/database.js';
import { FakeClock } from '../src/core/clock/clock.js';
import { setupDb, type TestContext } from './helpers.js';

/** Fixtures for the audit-monitoring integration tests: SQL rows shaped like the producers write them. */

export const ORG = SEED_IDS.org;
export const RMS = SEED_IDS.venues.RMS;
export const LYL = SEED_IDS.venues.LYL;
export const POOL_R = SEED_IDS.pools['POOL-R'];
export const U = SEED_IDS.users;

const b64 = (s: string) => Buffer.from(s.padEnd(32, '.')).toString('base64');

export async function seededDb(clock = new FakeClock('2026-10-27T16:00:00.000Z')): Promise<TestContext> {
  const t = await setupDb(clock);
  const pool = new pg.Pool({ connectionString: t.testDb.url, max: 2 });
  try {
    await seed(pool, {
      env: 'test',
      nodeEnv: 'test',
      dataEncryptionKey: b64('data-key-for-tests'),
      dataEncryptionKeyId: 'test1',
      secretPepper: b64('auth-pepper-for-tests'),
    });
  } finally {
    await pool.end();
  }
  return t;
}

type Q = Pick<Database, 'query'>;

export async function insertEvent(
  db: Q,
  o: { venueId?: string; poolId?: string; status?: string; closedAt?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO events (id, org_id, venue_id, dispatch_pool_id, name_ar, event_date, status, closed_at, created_by)
     VALUES ($1, $2, $3, $4, 'حفل', '2026-01-01', $5, $6, $7)`,
    [
      id,
      ORG,
      o.venueId ?? RMS,
      o.poolId ?? POOL_R,
      o.status ?? 'closed',
      o.status === 'closed' || o.status === undefined ? (o.closedAt ?? '2026-01-02T00:00:00Z') : null,
      U.OWN1,
    ],
  );
  return id;
}

let displayNumber = 1000;

export async function insertTicket(
  db: Q,
  o: {
    eventId: string;
    venueId?: string;
    poolId?: string;
    status?: string;
    createdAt?: string;
    submittedAt?: string | null;
    deliveredAt?: string | null;
    customerId?: string | null;
    plate?: string | null;
    notes?: string | null;
    channel?: 'whatsapp' | 'paper';
    paperSerial?: string | null;
    feeHalalas?: number;
    paymentStatus?: string;
    waLinkStatus?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const status = o.status ?? 'delivered';
  const number = displayNumber++;
  await db.query(
    `INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, channel, customer_id,
                          paper_serial, plate_digits, plate_letters_ar, vehicle_make, vehicle_color, notes, key_tag,
                          created_by, created_at, submitted_at, delivered_at, delivered_by, vehicle_holder_type,
                          voided_at, void_reason, fee_halalas, payment_status, wa_link_status, current_spot_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Toyota', 'أبيض', $13, $25,
             $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, 'beside the gate')`,
    [
      id,
      ORG,
      o.venueId ?? RMS,
      o.eventId,
      o.poolId ?? POOL_R,
      number,
      status,
      o.channel ?? 'whatsapp',
      o.customerId === undefined ? SEED_IDS.customers.CUS1 : o.customerId,
      o.paperSerial ?? null,
      o.plate === undefined ? '1234' : o.plate,
      o.plate === null ? null : 'ب ح د',
      o.notes === undefined ? 'scratch on the left door' : o.notes,
      U.DRV1,
      o.createdAt ?? '2026-01-01T18:00:00Z',
      o.submittedAt === undefined ? '2026-01-01T18:02:00Z' : o.submittedAt,
      status === 'delivered' ? (o.deliveredAt ?? '2026-01-01T22:00:00Z') : null,
      status === 'delivered' ? U.DRV2 : null,
      status === 'delivered' ? 'customer' : 'driver',
      status === 'voided' ? '2026-01-01T19:00:00Z' : null,
      status === 'voided' ? 'test' : null,
      o.feeHalalas ?? 0,
      o.paymentStatus ?? 'not_required',
      o.waLinkStatus ?? 'none',
      `K${number}`,
    ],
  );
  return id;
}

export async function insertIncident(
  db: Q,
  o: { ticketId?: string | null; eventId?: string | null; status?: string; resolvedAt?: string | null },
): Promise<string> {
  const id = randomUUID();
  const status = o.status ?? 'open';
  const resolved = status === 'resolved' || status === 'closed';
  await db.query(
    `INSERT INTO incidents (id, org_id, venue_id, event_id, ticket_id, type, status, severity, description, opened_by,
                            resolution, resolved_at, resolved_by)
     VALUES ($1, $2, $3, $4, $5, 'vehicle_damage', $6, 'high', 'hold', $7, $8, $9, $10)`,
    [
      id,
      ORG,
      RMS,
      o.eventId ?? null,
      o.ticketId ?? null,
      status,
      U['SUP-R'],
      resolved ? 'done' : null,
      resolved ? (o.resolvedAt ?? '2026-01-03T00:00:00Z') : null,
      resolved ? U['SUP-R'] : null,
    ],
  );
  return id;
}

export async function insertMedia(
  db: Q,
  o: { ticketId: string; status?: string; key?: string; createdAt?: string; kind?: string },
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = o.key ?? `org/${ORG}/tickets/${o.ticketId}/${id}.jpg`;
  await db.query(
    `INSERT INTO media_assets (id, org_id, ticket_id, kind, storage_key, content_type, byte_size, upload_status, uploaded_by,
                               created_at, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, 'image/jpeg', 1000, $6, $7, $8, $9)`,
    [
      id,
      ORG,
      o.ticketId,
      o.kind ?? 'photo_front',
      key,
      o.status ?? 'uploaded',
      U.DRV1,
      o.createdAt ?? '2026-01-01T18:01:00Z',
      (o.status ?? 'uploaded') === 'uploaded' ? (o.createdAt ?? '2026-01-01T18:01:00Z') : null,
    ],
  );
  return { id, key };
}

export async function insertMessage(
  db: Q,
  o: {
    ticketId?: string | null;
    createdAt?: string;
    direction?: 'outbound' | 'inbound';
    notificationId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const inbound = o.direction === 'inbound';
  await db.query(
    `INSERT INTO whatsapp_messages (id, org_id, channel_id, direction, kind, purpose, body_redacted, payload_redacted,
                                    recipient_wa_id, sender_wa_id, customer_id, ticket_id, status, notification_id, created_at, queued_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'تذكرة 125 جاهزة', '{"text":"x"}', $7, $8, $9, $10, $11, $12, $13, $13)`,
    [
      id,
      ORG,
      SEED_IDS.whatsappChannel,
      inbound ? 'inbound' : 'outbound',
      inbound ? 'inbound_text' : 'template',
      inbound ? null : 'W-05',
      inbound ? null : '966551234567',
      inbound ? '966551234567' : null,
      SEED_IDS.customers.CUS1,
      o.ticketId ?? null,
      inbound ? 'received' : 'delivered',
      o.notificationId ?? null,
      o.createdAt ?? '2026-01-01T21:00:00Z',
    ],
  );
  return id;
}

export async function insertNotification(
  db: Q,
  o: { ticketId?: string | null; createdAt?: string; status?: string },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO notifications (id, org_id, channel, purpose, recipient_customer_id, venue_id, ticket_id, status, created_at)
     VALUES ($1, $2, 'whatsapp', 'W-05', $3, $4, $5, $6, $7)`,
    [
      id,
      ORG,
      SEED_IDS.customers.CUS1,
      RMS,
      o.ticketId ?? null,
      o.status ?? 'sent',
      o.createdAt ?? '2026-01-01T21:00:00Z',
    ],
  );
  await db.query(
    `INSERT INTO notification_attempts (notification_id, attempt_no, started_at, outcome) VALUES ($1, 1, $2, 'success')`,
    [id, o.createdAt ?? '2026-01-01T21:00:00Z'],
  );
  return id;
}

/** A duty session for a seeded driver in the seeded open shift of RMS. */
export async function insertDuty(
  db: Q,
  o: {
    userId: string;
    status?: string;
    startedAt?: string;
    connection?: string;
    assignmentId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO duty_sessions (id, org_id, user_id, shift_id, venue_id, dispatch_pool_id, assignment_id, status,
                                connection_state, available_since, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      ORG,
      o.userId,
      SEED_IDS.shifts['SHF-R'],
      RMS,
      POOL_R,
      o.assignmentId === undefined
        ? ((SEED_IDS.assignments as Record<string, string>)[
            Object.entries(U).find(([, v]) => v === o.userId)?.[0] ?? ''
          ] ?? null)
        : o.assignmentId,
      o.status ?? 'on_duty',
      o.connection ?? 'online',
      (o.status ?? 'on_duty') === 'on_duty' ? (o.startedAt ?? '2026-10-27T15:00:00Z') : null,
      o.startedAt ?? '2026-10-27T15:00:00Z',
    ],
  );
  return id;
}

/** A retrieve task with its open cycle for a ticket of an open seeded event. */
export async function insertRetrieveTask(
  db: Q,
  o: {
    ticketId: string;
    eventId: string;
    status: string;
    assigneeId?: string | null;
    requestedAt?: string;
    acceptedAt?: string | null;
    startedAt?: string | null;
    readyAt?: string | null;
  },
): Promise<{ taskId: string; cycleId: string }> {
  const cycleId = randomUUID();
  const taskId = randomUUID();
  await db.query(
    `INSERT INTO retrieval_cycles (id, org_id, venue_id, ticket_id, cycle_no, requested_at, request_source, requested_by_user_id,
                                   request_reason, accepted_by, started_at, ready_at)
     VALUES ($1, $2, $3, $4, 1, $5, 'staff', $6, 'test', $7, $8, $9)`,
    [
      cycleId,
      ORG,
      RMS,
      o.ticketId,
      o.requestedAt ?? '2026-10-27T15:30:00Z',
      U['SUP-R'],
      o.assigneeId ?? null,
      o.startedAt ?? null,
      o.readyAt ?? null,
    ],
  );
  await db.query(
    `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status, priority_at,
                        assignee_id, queued_at, claimed_at, accepted_at, started_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'retrieve', $8, $9, $10, $9, $11, $11, $12, $9)`,
    [
      taskId,
      ORG,
      RMS,
      POOL_R,
      o.eventId,
      o.ticketId,
      cycleId,
      o.status,
      o.requestedAt ?? '2026-10-27T15:30:00Z',
      o.assigneeId ?? null,
      o.acceptedAt ?? null,
      o.startedAt ?? null,
    ],
  );
  return { taskId, cycleId };
}

/** Rows that pg_stat_activity shows as an open transaction on the test database (besides ours). */
export async function openTransactions(db: Q, dbName: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = $1 AND state IN ('idle in transaction', 'idle in transaction (aborted)') AND pid <> pg_backend_pid()`,
    [dbName],
  );
  return r.rows[0]?.n ?? 0;
}
