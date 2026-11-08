import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { registerTxPlanner, unregisterTxPlanner, type TxPlanner } from '../../../core/db/tx-planners.js';
import { newId } from '../../../core/crypto/ids.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';

/** One notification to create, with the job that delivers it (DEC-41). */
export interface PlannedNotification {
  channel: 'whatsapp' | 'push';
  /** canon §11 W-xx or a push kind (canon §5.7) */
  purpose: string;
  orgId: string;
  venueId: string | null;
  ticketId: string | null;
  taskId: string | null;
  recipientCustomerId: string | null;
  recipientUserId: string | null;
  recipientDeviceId: string | null;
  /** notifications.dedupe_key — the same notification is never created twice */
  dedupeKey: string;
  /** the outbox event that produced it */
  sourceEventId: string;
  job: {
    type: 'job.wa_send' | 'job.push_send';
    orderingKey: string | null;
    /** ids only; `notification_id` is added here */
    payload: Record<string, unknown>;
    maxAttempts: number;
  };
}

/**
 * A channel's rules (WhatsApp customer messages now, Web Push in S5): turns one committed-to-be event into
 * notifications. Runs inside the producing transaction, reads what it needs, never calls the network.
 */
export interface NotificationRule {
  name: string;
  plan(tx: Tx, ev: EventEnvelope): Promise<PlannedNotification[]>;
}

const rules: NotificationRule[] = [];

export function registerNotificationRule(rule: NotificationRule): void {
  if (rules.some((r) => r.name === rule.name)) return;
  rules.push(rule);
}

export function unregisterNotificationRule(name: string): void {
  const i = rules.findIndex((r) => r.name === name);
  if (i >= 0) rules.splice(i, 1);
}

export function registeredNotificationRules(): readonly NotificationRule[] {
  return rules;
}

/**
 * Inserts the notification (`ON CONFLICT (dedupe_key) DO NOTHING`) and, only when it is new, its job in
 * the same transaction. Returns the notification id, or null for a duplicate.
 */
export async function insertNotification(tx: Tx, n: PlannedNotification): Promise<string | null> {
  const r = await tx.maybeOne<{ id: string }>(
    `INSERT INTO notifications (id, org_id, channel, purpose, recipient_customer_id, recipient_user_id, recipient_device_id,
            venue_id, ticket_id, task_id, source_outbox_id, dedupe_key, status, created_at, updated_at)
     VALUES ($13, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $12)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [
      n.orgId,
      n.channel,
      n.purpose,
      n.recipientCustomerId,
      n.recipientUserId,
      n.recipientDeviceId,
      n.venueId,
      n.ticketId,
      n.taskId,
      n.sourceEventId,
      n.dedupeKey,
      tx.now,
      newId(), // UUIDv7 (05 §7.1): notifications of one instant keep their creation order
    ],
  );
  if (!r) return null;
  await enqueue(tx, {
    type: n.job.type,
    orgId: n.orgId,
    venueId: n.venueId,
    orderingKey: n.job.orderingKey,
    payload: { notification_id: r.id, ...n.job.payload },
    maxAttempts: n.job.maxAttempts,
  });
  return r.id;
}

/**
 * NotificationPlanner (DEC-41, 04 §6): a TxPlanner run before COMMIT over the transaction's domain events,
 * so no change commits without its notification and no notification exists without its change.
 */
export const notificationPlanner: TxPlanner = {
  name: 'notification-planner',
  async plan(tx, events) {
    if (rules.length === 0) return;
    for (const ev of events) {
      for (const rule of rules) {
        for (const n of await rule.plan(tx, ev)) await insertNotification(tx, n);
      }
    }
  },
};

/** Registers the planner (idempotent): the api and the worker both plan in their transactions. */
export function startNotificationPlanner(): void {
  registerTxPlanner(notificationPlanner);
}

export function stopNotificationPlanner(): void {
  unregisterTxPlanner(notificationPlanner.name);
}
