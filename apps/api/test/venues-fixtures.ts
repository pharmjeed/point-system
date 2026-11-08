import { randomUUID } from 'node:crypto';
import type { Database } from '@point/server';
import { SEED_IDS } from './harness.js';

/**
 * Rows that the tickets/dispatch modules will create through their own commands (S2+). The venues-events tests
 * insert them directly to put the venue in the state a scenario needs (occupied spots, custody, open tasks,
 * open duty sessions); every row respects the checks of docs/06_schema.sql.
 */

type Holder = {
  type: 'customer' | 'driver' | 'spot' | 'key_slot' | 'supervisor' | 'unknown';
  id: string | null;
};

export interface TicketFixture {
  eventId: string;
  venueId: string;
  poolId: string;
  displayNumber: number;
  status:
    | 'received'
    | 'parking'
    | 'parked'
    | 'requested'
    | 'assigned'
    | 'assigned_waiting'
    | 'retrieving'
    | 'ready'
    | 'delivered'
    | 'reparking'
    | 'voided';
  createdBy: string;
  vehicle?: Holder;
  key?: Holder;
  spotId?: string | null;
  keySlotId?: string | null;
}

export async function insertTicket(db: Database, f: TicketFixture): Promise<string> {
  const id = randomUUID();
  const vehicle = f.vehicle ?? { type: 'driver', id: f.createdBy };
  const key = f.key ?? { type: 'driver', id: f.createdBy };
  await db.query(
    `INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, created_by,
                          vehicle_holder_type, vehicle_holder_id, key_holder_type, key_holder_id,
                          current_spot_id, current_key_slot_id, fee_halalas, payment_status,
                          voided_at, void_reason, delivered_at, delivered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, 'not_required',
             CASE WHEN $7 = 'voided' THEN now() END, CASE WHEN $7 = 'voided' THEN 'test void' END,
             CASE WHEN $7 = 'delivered' THEN now() END, CASE WHEN $7 = 'delivered' THEN $8::uuid END)`,
    [
      id,
      SEED_IDS.org,
      f.venueId,
      f.eventId,
      f.poolId,
      f.displayNumber,
      f.status,
      f.createdBy,
      vehicle.type,
      vehicle.id,
      key.type,
      key.id,
      f.spotId ?? null,
      f.keySlotId ?? null,
    ],
  );
  return id;
}

/** A parked ticket of EVT-R1 occupying a spot and a key slot (active allocations). */
export async function parkTicket(
  db: Database,
  o: { displayNumber: number; spotId: string; keySlotId: string; by: string; eventId?: string },
): Promise<string> {
  const ticketId = await insertTicket(db, {
    eventId: o.eventId ?? SEED_IDS.events['EVT-R1'],
    venueId: SEED_IDS.venues.RMS,
    poolId: SEED_IDS.pools['POOL-R'],
    displayNumber: o.displayNumber,
    status: 'parked',
    createdBy: o.by,
    vehicle: { type: 'spot', id: o.spotId },
    key: { type: 'key_slot', id: o.keySlotId },
    spotId: o.spotId,
    keySlotId: o.keySlotId,
  });
  await db.query(
    `INSERT INTO spot_allocations (org_id, ticket_id, parking_spot_id, allocated_by) VALUES ($1, $2, $3, $4)`,
    [SEED_IDS.org, ticketId, o.spotId, o.by],
  );
  await db.query(
    `INSERT INTO key_slot_allocations (org_id, ticket_id, key_slot_id, allocated_by) VALUES ($1, $2, $3, $4)`,
    [SEED_IDS.org, ticketId, o.keySlotId, o.by],
  );
  return ticketId;
}

export async function insertTask(
  db: Database,
  f: {
    ticketId: string;
    eventId: string;
    venueId: string;
    poolId: string;
    type: 'park' | 'retrieve' | 'repark';
    status:
      'queued' | 'offered' | 'broadcast' | 'assigned_waiting' | 'accepted' | 'in_progress' | 'completed';
    assigneeId: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  let cycleId: string | null = null;
  if (f.type === 'retrieve') {
    cycleId = randomUUID();
    await db.query(
      `INSERT INTO retrieval_cycles (id, org_id, venue_id, ticket_id, cycle_no, requested_at, request_source,
                                     requested_by_user_id, request_reason)
       VALUES ($1, $2, $3, $4, 1, now(), 'staff', $5, 'test request')`,
      [cycleId, SEED_IDS.org, f.venueId, f.ticketId, SEED_IDS.users['SUP-R']],
    );
  }
  await db.query(
    `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status,
                        priority_at, assignee_id, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, CASE WHEN $9 = 'completed' THEN now() END)`,
    [id, SEED_IDS.org, f.venueId, f.poolId, f.eventId, f.ticketId, cycleId, f.type, f.status, f.assigneeId],
  );
  return id;
}

/** An open duty session (`on_duty`, available) in a shift. */
export async function startDuty(
  db: Database,
  f: { userId: string; shiftId: string; venueId: string; poolId: string; assignmentId: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO duty_sessions (id, org_id, user_id, shift_id, venue_id, dispatch_pool_id, assignment_id, status,
                                started_at, available_since)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'on_duty', now(), now())`,
    [id, SEED_IDS.org, f.userId, f.shiftId, f.venueId, f.poolId, f.assignmentId],
  );
  return id;
}

/** Ends a driver's active assignment (a driver without assignment → ASSIGNMENT_REQUIRED). */
export async function endAssignment(db: Database, driverId: string): Promise<void> {
  await db.query(
    `UPDATE driver_assignments SET status = 'ended', ends_at = now() WHERE driver_id = $1 AND status = 'active'`,
    [driverId],
  );
}

export async function outboxTypes(db: Database, aggregateId: string): Promise<string[]> {
  const r = await db.query<{ type: string }>(
    `SELECT type FROM outbox_events WHERE aggregate_id = $1 ORDER BY seq`,
    [aggregateId],
  );
  return r.rows.map((x) => x.type);
}

export async function auditRows(db: Database, entityId: string) {
  const r = await db.query(
    `SELECT action, entity_type, entity_id, venue_id, actor_id, reason, before, after, metadata, request_id
       FROM audit_log WHERE entity_id = $1 ORDER BY id`,
    [entityId],
  );
  return r.rows as Array<{
    action: string;
    entity_type: string;
    entity_id: string;
    venue_id: string | null;
    actor_id: string;
    reason: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    request_id: string | null;
  }>;
}
