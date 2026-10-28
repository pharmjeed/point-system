import type { Tx } from '../db/tx.js';
import { redact } from '../logging/redact.js';

export interface Actor {
  type: 'user' | 'customer' | 'system';
  id: string | null;
  role?: string | null;
}

export interface AuditEntry {
  orgId: string;
  actor: Actor;
  /** permission/command name (canon §10) or job type for system actions (11 §1.1 rule 4) */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  venueId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/** audit_log is append-only (the app role has no UPDATE/DELETE on it). Diffs are redacted. */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (org_id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, venue_id, request_id, ip, user_agent, reason, before, after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      e.orgId,
      tx.now,
      e.actor.type,
      e.actor.id,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      e.venueId ?? null,
      e.requestId ?? null,
      e.ip ?? null,
      e.userAgent?.slice(0, 512) ?? null,
      e.reason ?? null,
      e.before ? JSON.stringify(redact(e.before)) : null,
      e.after ? JSON.stringify(redact(e.after)) : null,
      e.metadata
        ? JSON.stringify(redact({ ...e.metadata, actor_role: e.actor.role ?? undefined }))
        : e.actor.role
          ? JSON.stringify({ actor_role: e.actor.role })
          : null,
    ],
  );
  tx.auditCount++;
}

export interface TicketEventEntry {
  orgId: string;
  venueId: string;
  ticketId: string;
  /** domain event type (canon §7.1); task.*, custody.changed, handover.*, payment.* are allowed (11 §1.6) */
  type: string;
  actor: Actor;
  /** ticket version after the change */
  ticketVersion: number;
  data?: Record<string, unknown>;
}

export async function appendTicketEvent(tx: Tx, e: TicketEventEntry): Promise<void> {
  await tx.query(
    `INSERT INTO ticket_events (org_id, venue_id, ticket_id, type, actor_type, actor_id, ticket_version, data, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.orgId,
      e.venueId,
      e.ticketId,
      e.type,
      e.actor.type,
      e.actor.id,
      e.ticketVersion,
      JSON.stringify(redact(e.data ?? {})),
      tx.now,
    ],
  );
}

export type HolderType = 'customer' | 'driver' | 'spot' | 'key_slot' | 'supervisor' | 'unknown';

export interface CustodyEventEntry {
  orgId: string;
  venueId: string;
  ticketId: string;
  subject: 'vehicle' | 'key';
  from: { type: HolderType; id: string | null };
  to: { type: HolderType; id: string | null };
  reason:
    | 'intake'
    | 'parked'
    | 'key_deposited'
    | 'key_pickup'
    | 'retrieval_start'
    | 'handover'
    | 'repark'
    | 'official_transfer'
    | 'withdrawal_release'
    | 'manual_reconcile'
    | 'correction';
  taskId?: string | null;
  actorId: string;
  note?: string | null;
}

/** Returns the custody_events id (the `custody.changed` payload carries it, 11 §8.6). */
export async function appendCustodyEvent(tx: Tx, e: CustodyEventEntry): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO custody_events (org_id, venue_id, ticket_id, subject, from_holder_type, from_holder_id, to_holder_type, to_holder_id, reason, task_id, actor_id, note, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [
      e.orgId,
      e.venueId,
      e.ticketId,
      e.subject,
      e.from.type,
      e.from.id,
      e.to.type,
      e.to.id,
      e.reason,
      e.taskId ?? null,
      e.actorId,
      e.note ?? null,
      tx.now,
    ],
  );
  return r.rows[0]!.id;
}
