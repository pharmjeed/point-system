import type { Tx, EventEnvelope } from '../db/tx.js';
import { InvariantViolation } from '../errors/app-error.js';
import { findSensitiveKeys } from '../logging/redact.js';
import { newId } from '../crypto/ids.js';

export const OUTBOX_NOTIFY_CHANNEL = process.env.OUTBOX_NOTIFY_CHANNEL ?? 'point_outbox';

export interface OutboxInsert {
  type: string;
  orgId: string;
  venueId?: string | null;
  aggregate?: { type: string; id: string; version?: number | null } | null;
  payload?: Record<string, unknown>;
  /** timers: a future instant; defaults to the transaction's now */
  availableAt?: Date;
  /** serialize per key: 'wa:<ticket_id>' for job.wa_send only (DEC-41) */
  orderingKey?: string | null;
  /** collapse duplicate pending jobs, e.g. 'dispatch_pass:<pool_id>' */
  dedupeKey?: string | null;
  maxAttempts?: number;
  id?: string;
}

/**
 * Appends a row to outbox_events inside the caller's transaction (L10). Payloads never carry secrets, codes,
 * phone numbers or tokens (PNT-007 AC6, DEC-38): a payload with a sensitive key is a programming error.
 * Returns the row id, or null when an equal pending job already exists (uq_outbox_dedupe_pending).
 */
export async function enqueue(tx: Tx, row: OutboxInsert): Promise<string | null> {
  const payload = row.payload ?? {};
  const leaks = findSensitiveKeys(payload);
  if (leaks.length)
    throw new InvariantViolation(
      `outbox payload for ${row.type} contains sensitive keys: ${leaks.join(', ')}`,
    );
  const id = row.id ?? newId();
  const r = await tx.query<{ id: string }>(
    `INSERT INTO outbox_events (id, org_id, type, aggregate_type, aggregate_id, aggregate_version, venue_id, ordering_key, dedupe_key, payload, available_at, max_attempts, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, 8), $13)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','processing') DO NOTHING
     RETURNING id`,
    [
      id,
      row.orgId,
      row.type,
      row.aggregate?.type ?? null,
      row.aggregate?.id ?? null,
      row.aggregate?.version ?? null,
      row.venueId ?? null,
      row.orderingKey ?? null,
      row.dedupeKey ?? null,
      JSON.stringify(payload),
      row.availableAt ?? tx.now,
      row.maxAttempts ?? null,
      tx.now,
    ],
  );
  wakeWorkers(tx, row.venueId ?? null);
  return r.rows[0]?.id ?? null;
}

/** schedule(tx, 'job.offer_expire', at, { dedupeKey, aggregate }) — a durable timer (04 §6.5). */
export function schedule(
  tx: Tx,
  type: string,
  availableAt: Date,
  row: Omit<OutboxInsert, 'type' | 'availableAt'>,
): Promise<string | null> {
  return enqueue(tx, { ...row, type, availableAt });
}

export interface DomainEventInput<P extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  orgId: string;
  venueId?: string | null;
  dispatchPoolId?: string | null;
  eventId?: string | null;
  aggregate: { type: string; id: string; version?: number | null };
  actor: { type: 'user' | 'customer' | 'system'; id: string | null };
  payload?: P;
}

/**
 * Writes a domain event (canon §7.1) to the outbox (no ordering key, DEC-41) and keeps it on the transaction
 * so the NotificationPlanner can turn this transaction's events into notifications before COMMIT.
 * The outbox row id is the event id.
 */
export async function emitEvent<P extends Record<string, unknown>>(
  tx: Tx,
  ev: DomainEventInput<P>,
): Promise<EventEnvelope<P>> {
  const envelope: EventEnvelope<P> = {
    id: newId(),
    type: ev.type,
    occurred_at: tx.now.toISOString(),
    org_id: ev.orgId,
    venue_id: ev.venueId ?? null,
    dispatch_pool_id: ev.dispatchPoolId ?? null,
    event_id: ev.eventId ?? null,
    aggregate: { type: ev.aggregate.type, id: ev.aggregate.id, version: ev.aggregate.version ?? null },
    actor: ev.actor,
    payload: (ev.payload ?? {}) as P,
  };
  await enqueue(tx, {
    id: envelope.id,
    type: ev.type,
    orgId: ev.orgId,
    venueId: ev.venueId ?? null,
    aggregate: envelope.aggregate,
    payload: envelope as unknown as Record<string, unknown>,
  });
  tx.events.push(envelope as EventEnvelope);
  return envelope;
}

/** NOTIFY is transactional: delivered to the LISTENing workers only after COMMIT (04 §6.2). */
function wakeWorkers(tx: Tx, venueId: string | null) {
  tx.onBeforeCommit(async () => {
    await tx.query(`SELECT pg_notify($1, $2)`, [OUTBOX_NOTIFY_CHANNEL, venueId ?? '']);
  }, 'outbox-notify');
}
