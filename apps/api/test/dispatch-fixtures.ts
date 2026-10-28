import { SEED_IDS, seedKeySlotId, seedSpotId } from '@point/db/seed';
import type { Database } from '@point/server';
import { expect } from 'vitest';
import { createTestApp, type TestApp } from './harness.js';

/**
 * Shared fixtures of the S2 backend tests (PNT-024 … PNT-034): actors, the HTTP steps of the vertical slice,
 * direct-SQL setups for states the API cannot reach yet in S2 (broadcast rounds, reserved next tasks), and the
 * consistency checks of 10 §14.1 and 11 §1.7 run after every step.
 */
export const RMS = SEED_IDS.venues.RMS;
export const LYL = SEED_IDS.venues.LYL;
export const POOL_R = SEED_IDS.pools['POOL-R'];
export const POOL_L = SEED_IDS.pools['POOL-L'];
export const EVT_R1 = SEED_IDS.events['EVT-R1']; // included (no fee)
export const EVT_R2 = SEED_IDS.events['EVT-R2']; // per_vehicle 2000
export const EVT_L1 = SEED_IDS.events['EVT-L1'];
export const U = SEED_IDS.users;
export const spot = (label: string) => seedSpotId(label);
export const slot = (n: number) => seedKeySlotId('RMS', n);
export const PHOTO_KINDS = ['photo_front', 'photo_rear', 'photo_left', 'photo_right'] as const;

export async function createS2App(): Promise<TestApp> {
  const t = await createTestApp();
  // 50 parallel intakes queue on one pool row: give the waiters room (the production default stays 3 s)
  (t.db.config as { lockTimeoutMs?: number }).lockTimeoutMs = 20000;
  // supertest binds an ephemeral listener per parallel request: 50 at once is expected, not a leak
  (t.app.getHttpServer() as { setMaxListeners(n: number): unknown }).setMaxListeners(128);
  return t;
}

export type Res = Awaited<ReturnType<TestApp['command']>>;

export function ok(res: Res, status = 200) {
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export function err(res: Res, code: string, status?: number) {
  expect({ status: res.status, code: res.body?.error?.code }).toMatchObject({
    code,
    ...(status ? { status } : {}),
  });
  return res.body.error.details ?? {};
}

export const startDuty = (t: TestApp, as: string, body: Record<string, unknown> = {}): Promise<Res> =>
  t.command('post', '/v1/me/duty/start', { as, body });

export const startIntake = (
  t: TestApp,
  as: string,
  body: Record<string, unknown> = { event_id: EVT_R1 },
): Promise<Res> => t.command('post', '/v1/tickets', { as, body });

export const patchIntake = (
  t: TestApp,
  as: string,
  ticketId: string,
  body: Record<string, unknown>,
): Promise<Res> => t.command('patch', `/v1/tickets/${ticketId}/intake`, { as, body });

export const submitIntake = (
  t: TestApp,
  as: string,
  ticketId: string,
  body: Record<string, unknown>,
): Promise<Res> => t.command('post', `/v1/tickets/${ticketId}/submit-intake`, { as, body });

export const completeParking = (
  t: TestApp,
  as: string,
  taskId: string,
  body: Record<string, unknown>,
): Promise<Res> => t.command('post', `/v1/tasks/${taskId}/complete-parking`, { as, body });

export const requestRetrieval = (
  t: TestApp,
  as: string,
  ticketId: string,
  reason = 'العميل عند البوابة',
): Promise<Res> => t.command('post', `/v1/tickets/${ticketId}/retrievals`, { as, body: { reason } });

export const accept = (t: TestApp, as: string, offerId: string, key?: string): Promise<Res> =>
  t.command('post', `/v1/task-offers/${offerId}/accept`, { as, body: {}, key });

export const keyPickup = (t: TestApp, as: string, taskId: string, keySlotId: string): Promise<Res> =>
  t.command('post', `/v1/tasks/${taskId}/key-pickup`, { as, body: { key_slot_id: keySlotId } });

export const startRetrieval = (t: TestApp, as: string, taskId: string): Promise<Res> =>
  t.command('post', `/v1/tasks/${taskId}/start-retrieval`, { as, body: {} });

export const markReady = (t: TestApp, as: string, taskId: string): Promise<Res> =>
  t.command('post', `/v1/tasks/${taskId}/ready`, { as, body: {} });

export const handover = (
  t: TestApp,
  as: string,
  ticketId: string,
  body: Record<string, unknown>,
): Promise<Res> => t.command('post', `/v1/tickets/${ticketId}/handover`, { as, body });

export const PAPER_DRAFT = (serial: string, keyTag: string, digits = '1234') => ({
  channel: 'paper',
  plate: { digits, letters_ar: 'ب ح د' },
  vehicle: { make: 'تويوتا', model: 'كامري', color: 'أبيض', type: 'sedan' },
  paper_serial: serial,
  key_tag: keyTag,
});

/** Inspection photos as the media module leaves them after a completed upload (PNT-027). */
export async function addPhotos(
  db: Database,
  ticketId: string,
  uploadedBy: string,
  kinds: readonly string[] = PHOTO_KINDS,
  status: 'uploaded' | 'failed' | 'pending' = 'uploaded',
) {
  for (const kind of kinds) {
    await db.query(
      `INSERT INTO media_assets (org_id, ticket_id, kind, storage_key, content_type, byte_size, upload_status, uploaded_by, uploaded_at)
       SELECT org_id, id, $2, 'org/' || org_id || '/tickets/' || id || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 1000, $4, $3,
              CASE WHEN $4 = 'uploaded' THEN now() END
         FROM tickets WHERE id = $1`,
      [ticketId, kind, uploadedBy, status],
    );
  }
}

export interface Draft {
  ticketId: string;
  taskId: string;
  displayNumber: number;
  version: number;
}

/** POST /v1/tickets → the draft and its park task. */
export async function newDraft(t: TestApp, as: string, eventId: string = EVT_R1): Promise<Draft> {
  const d = ok(await startIntake(t, as, { event_id: eventId }), 201);
  return {
    ticketId: d.ticket.id,
    taskId: d.task.id,
    displayNumber: d.ticket.display_number,
    version: d.ticket.version,
  };
}

let serialSeq = 100;
/** Intake of a paper ticket up to `parking` (POST /v1/tickets → PATCH → photos → submit). */
export async function paperTicketInParking(
  t: TestApp,
  as: string,
  opts: { eventId?: string; serial?: string; keyTag?: string } = {},
): Promise<Draft & { serial: string }> {
  const serial = opts.serial ?? `P-${serialSeq++}`;
  const d = await newDraft(t, as, opts.eventId ?? EVT_R1);
  const p = ok(
    await patchIntake(t, as, d.ticketId, {
      expected_version: d.version,
      ...PAPER_DRAFT(
        serial,
        opts.keyTag ?? `K-${serialSeq++}`,
        String(1000 + (serialSeq % 9000)).slice(0, 4),
      ),
    }),
  );
  await addPhotos(t.db, d.ticketId, (U as Record<string, string>)[as] ?? as);
  const s = ok(await submitIntake(t, as, d.ticketId, { expected_version: p.version }));
  return { ...d, version: s.version, serial };
}

let spotSeq = 1;
let slotSeq = 1;
export const nextSpot = () => spot(`A-${String(spotSeq++).padStart(2, '0')}`);
export const nextSlot = () => slot(slotSeq++);

/** Intake + park: a paper ticket `parked` in a fresh spot and key slot. */
export async function parkedPaperTicket(t: TestApp, as: string, opts: { eventId?: string } = {}) {
  const d = await paperTicketInParking(t, as, opts);
  const spotId = nextSpot();
  const slotId = nextSlot();
  const r = ok(await completeParking(t, as, d.taskId, { parking_spot_id: spotId, key_slot_id: slotId }));
  return { ...d, spotId, slotId, version: r.ticket.version };
}

export async function liveOffer(
  db: Database,
  userId: string,
): Promise<{ id: string; task_id: string } | null> {
  const r = await db.query<{ id: string; task_id: string }>(
    `SELECT o.id, o.task_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
      WHERE r.user_id = $1 AND o.status = 'active' ORDER BY o.created_at DESC LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

export async function one<R = any>(db: Database, sql: string, params: unknown[] = []): Promise<R> {
  const r = await db.query(sql, params);
  if (r.rows.length !== 1) throw new Error(`expected one row, got ${r.rows.length}: ${sql}`);
  return r.rows[0] as R;
}

export async function rows<R = any>(db: Database, sql: string, params: unknown[] = []): Promise<R[]> {
  return (await db.query(sql, params)).rows as R[];
}

let driverSeq = 0;
/** Extra RMS/LYL drivers with an active assignment (the seed has six in RMS). */
export async function createDrivers(db: Database, n: number, venueId = RMS): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = driverSeq++;
    const r = await db.query<{ id: string }>(
      `INSERT INTO users (org_id, employee_code, full_name, phone_e164, role, secret_kind, secret_hash, must_change_secret)
       VALUES ($1, $2, $3, $4, 'driver', 'pin', 'x', false) RETURNING id`,
      [SEED_IDS.org, `T-${String(k).padStart(4, '0')}`, `سائق اختبار ${k}`, `+9665${String(70000000 + k)}`],
    );
    const id = r.rows[0]!.id;
    await db.query(
      `INSERT INTO driver_assignments (org_id, driver_id, venue_id, status, starts_at, created_by)
       VALUES ($1, $2, $3, 'active', now(), $4)`,
      [SEED_IDS.org, id, venueId, U.ADM1],
    );
    ids.push(id);
  }
  return ids;
}

/**
 * A broadcast round for a queued retrieve task, as S4 will open it (10 §4.4): recipients = every on-duty driver
 * of the pool with the eligibility of 10 §4.4. Used to reach broadcast-only outcomes (assigned_waiting, races).
 */
export async function openBroadcastBySql(db: Database, taskId: string): Promise<string> {
  // the S4 engine may already have opened the broadcast itself (no single candidate, 10 §6)
  const live = await db.query<{ id: string }>(
    `SELECT id FROM task_offers WHERE task_id = $1 AND status = 'active' AND mode = 'broadcast'`,
    [taskId],
  );
  if (live.rows[0]) return live.rows[0].id;
  const offer = await one<{ id: string }>(
    db,
    `INSERT INTO task_offers (org_id, task_id, dispatch_pool_id, mode, round_no, status, created_at, reminder_at)
     SELECT t.org_id, t.id, t.dispatch_pool_id, 'broadcast',
            COALESCE((SELECT max(round_no) FROM task_offers WHERE task_id = t.id), 0) + 1, 'active', now(), now()
       FROM tasks t WHERE t.id = $1 RETURNING id`,
    [taskId],
  );
  await db.query(
    `INSERT INTO offer_recipients (offer_id, user_id, duty_session_id, eligible_as)
     SELECT $1, s.user_id, s.duty_session_id,
            CASE s.driver_state WHEN 'available' THEN 'accept' WHEN 'intake_parking' THEN 'reserve_next'
                                WHEN 'retrieving' THEN 'reserve_next' ELSE 'view_only' END
       FROM v_driver_state s JOIN tasks t ON t.id = $2
      WHERE s.dispatch_pool_id = t.dispatch_pool_id AND s.duty_status = 'on_duty'`,
    [offer.id, taskId],
  );
  await db.query(
    `UPDATE tasks SET status = 'broadcast', broadcast_at = now(), version = version + 1 WHERE id = $1 AND status = 'queued'`,
    [taskId],
  );
  return offer.id;
}

/** 10 §14.1 (I-A … I-F) and 11 §1.7: each query must return no row. */
export const INVARIANTS: Record<string, string> = {
  'I-A available ⟺ available_since': `SELECT s.user_id FROM v_driver_state s
     WHERE s.duty_status = 'on_duty' AND ((s.driver_state = 'available') <> (s.available_since IS NOT NULL))`,
  'I-B task status ⟺ live round': `SELECT t.id FROM tasks t LEFT JOIN task_offers o ON o.task_id = t.id AND o.status = 'active'
     WHERE t.type = 'retrieve' AND ((t.status = 'offered' AND (o.id IS NULL OR o.mode <> 'single'))
        OR (t.status = 'broadcast' AND (o.id IS NULL OR o.mode <> 'broadcast'))
        OR (t.status NOT IN ('offered','broadcast') AND o.id IS NOT NULL))`,
  'I-C ticket mirrors its retrieve task': `SELECT k.id FROM tickets k JOIN tasks t ON t.ticket_id = k.id AND t.type = 'retrieve' AND t.status NOT IN ('completed','canceled')
     WHERE NOT ((k.status = 'requested' AND t.status IN ('queued','offered','broadcast'))
             OR (k.status = 'assigned' AND t.status = 'accepted')
             OR (k.status = 'assigned_waiting' AND t.status = 'assigned_waiting')
             OR (k.status IN ('retrieving','ready') AND t.status = 'in_progress'))`,
  'I-D live single offers only for available drivers': `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
     JOIN v_driver_state s ON s.user_id = r.user_id
     WHERE o.status = 'active' AND o.mode = 'single' AND s.driver_state <> 'available'`,
  'I-E one live single offer per driver': `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
     WHERE o.status = 'active' AND o.mode = 'single' GROUP BY r.user_id HAVING count(*) > 1`,
  'I-F rounds never cross pools': `SELECT o.id FROM task_offers o JOIN tasks t ON t.id = o.task_id JOIN offer_recipients r ON r.offer_id = o.id
     LEFT JOIN duty_sessions ds ON ds.id = r.duty_session_id
     WHERE o.status = 'active' AND (o.dispatch_pool_id <> t.dispatch_pool_id OR ds.dispatch_pool_id <> o.dispatch_pool_id)`,
  '11 §1.7 ticket ↔ open task': `SELECT t.id, t.status, k.type AS open_task_type, k.status AS open_task_status
     FROM tickets t LEFT JOIN tasks k ON k.ticket_id = t.id AND k.status NOT IN ('completed','canceled')
     WHERE NOT (
          (t.status IN ('received','parking') AND k.type = 'park' AND k.status = 'in_progress')
       OR (t.status = 'requested' AND k.type = 'retrieve' AND k.status IN ('queued','offered','broadcast'))
       OR (t.status = 'assigned' AND k.type = 'retrieve' AND k.status = 'accepted')
       OR (t.status = 'assigned_waiting' AND k.type = 'retrieve' AND k.status = 'assigned_waiting')
       OR (t.status IN ('retrieving','ready') AND k.type = 'retrieve' AND k.status = 'in_progress')
       OR (t.status = 'reparking' AND k.type = 'repark' AND k.status = 'in_progress')
       OR (t.status IN ('parked','delivered','voided') AND k.id IS NULL))`,
};

export async function invariantViolations(db: Database): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [name, sql] of Object.entries(INVARIANTS)) {
    const r = await db.query(sql);
    if (r.rows.length) out[name] = r.rows;
  }
  return out;
}

export async function expectConsistent(db: Database): Promise<void> {
  expect(await invariantViolations(db)).toEqual({});
}

/** Events of a type written to the outbox in this database (payload = the canon §7 envelope). */
export async function outboxEvents(db: Database, type: string): Promise<any[]> {
  return (
    await db.query(
      `SELECT payload, aggregate_version, available_at, dedupe_key FROM outbox_events WHERE type = $1 ORDER BY seq`,
      [type],
    )
  ).rows;
}

export async function auditCount(db: Database, action: string, entityId?: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND ($2::uuid IS NULL OR entity_id = $2::uuid)`,
    [action, entityId ?? null],
  );
  return r.rows[0]!.n;
}
