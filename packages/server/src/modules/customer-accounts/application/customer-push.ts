import type { CustomerPushKind } from '@point/shared/customer';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { registerTxPlanner, unregisterTxPlanner, type TxPlanner } from '../../../core/db/tx-planners.js';
import {
  RetryableJobError,
  backoffMs,
  type JobContext,
  type JobHandler,
} from '../../../core/outbox/dispatcher.js';
import { enqueue, schedule } from '../../../core/outbox/outbox-writer.js';
import {
  CustomerPushTransportError,
  DEVICE_NOT_REGISTERED,
  EXPO_PUSH_RECEIPTS_LIMIT,
  type CustomerPushRuntime,
} from '../infra/customer-push.js';
import { customerPushContent } from './push-messages.js';

/** canon §7.2 V2 rows (V2-016, DEC-519). */
export const CUSTOMER_PUSH_SEND_JOB = 'job.customer_push_send';
export const CUSTOMER_PUSH_RECEIPTS_JOB = 'job.customer_push_receipts';

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** What one domain event pushes, if anything (docs/v2/01 §3; DEC-519). */
export interface CustomerPushIntent {
  kind: CustomerPushKind;
  ticketId: string;
  /** the episode the push is about: one push per kind and episode and device */
  ref: string;
}

/**
 * The customer column of docs/v2/01 §3 as a pure function of one event: the car received (the intake submitted, an
 * app ticket), the request accepted (the first assignment of the cycle, busy driver or not), the car ready, and the
 * reminder when it waits at the gate (`ready_not_collected`, 10 §12). Nothing else reaches the device: the live state
 * of C-12 comes over the customer socket (DEC-520).
 */
export function customerPushIntents(ev: Pick<EventEnvelope, 'type' | 'payload'>): CustomerPushIntent[] {
  const p = (ev.payload ?? {}) as Record<string, any>;
  const ticketId = str(p.ticket?.ticket_id) ?? str(p.ticket_id);
  const cycleId = str(p.cycle_id);
  switch (ev.type) {
    case 'ticket.intake_submitted':
      return ticketId && p.channel === 'app' ? [{ kind: 'car_received', ticketId, ref: ticketId }] : [];
    case 'ticket.assigned':
    case 'ticket.assigned_waiting':
      return ticketId && cycleId ? [{ kind: 'request_accepted', ticketId, ref: cycleId }] : [];
    case 'ticket.ready':
      return ticketId && cycleId ? [{ kind: 'car_ready', ticketId, ref: cycleId }] : [];
    case 'alert.raised': {
      const alertId = str(p.alert_id);
      return p.type === 'ready_not_collected' && ticketId && alertId
        ? [{ kind: 'pickup_reminder', ticketId, ref: alertId }]
        : [];
    }
    default:
      return [];
  }
}

interface Target {
  org_id: string;
  venue_id: string;
  channel: string;
  account_id: string;
}

/**
 * The customer push planner (a TxPlanner, before COMMIT): for an app ticket of an active account, one
 * `customer_push_messages` row per live session with a push token and its `job.customer_push_send`, in the
 * transaction of the change — no push without its change, no change without its push (DEC-41's rule). WhatsApp
 * tickets of an account keep their W-xx messages (no second channel). The row holds ids only.
 */
export const customerPushPlanner: TxPlanner = {
  name: 'customer-push-planner',
  async plan(tx, events) {
    for (const ev of events) {
      for (const intent of customerPushIntents(ev)) await planPush(tx, ev, intent);
    }
  },
};

async function planPush(tx: Tx, ev: EventEnvelope, intent: CustomerPushIntent): Promise<void> {
  const t = await tx.maybeOne<Target>(
    `SELECT t.org_id, t.venue_id, t.channel, c.customer_account_id AS account_id
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
       JOIN customer_accounts a ON a.id = c.customer_account_id
      WHERE t.id = $1 AND a.status = 'active'`,
    [intent.ticketId],
  );
  if (!t || t.channel !== 'app') return;
  const sessions = await tx.rows<{ id: string }>(
    `SELECT id FROM customer_account_sessions
      WHERE account_id = $1 AND revoked_at IS NULL AND push_token IS NOT NULL AND refresh_expires_at > $2
      ORDER BY id`,
    [t.account_id, tx.now],
  );
  for (const s of sessions) {
    const row = await tx.maybeOne<{ id: string }>(
      `INSERT INTO customer_push_messages (account_id, session_id, org_id, ticket_id, kind, dedupe_key, source_outbox_id,
                                           created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [
        t.account_id,
        s.id,
        t.org_id,
        intent.ticketId,
        intent.kind,
        `push:${intent.kind}:${intent.ref}:${s.id}`,
        ev.id,
        tx.now,
      ],
    );
    if (!row) continue;
    await enqueue(tx, {
      type: CUSTOMER_PUSH_SEND_JOB,
      orgId: t.org_id,
      venueId: t.venue_id,
      aggregate: { type: 'customer_push', id: row.id },
      payload: { push_id: row.id },
      maxAttempts: 5,
    });
  }
}

export function startCustomerPushPlanner(): void {
  registerTxPlanner(customerPushPlanner);
}

export function stopCustomerPushPlanner(): void {
  unregisterTxPlanner(customerPushPlanner.name);
}

// ---------------------------------------------------------------------------------------------
// job.customer_push_send — after COMMIT, outside any transaction
// ---------------------------------------------------------------------------------------------

interface PushRow {
  id: string;
  account_id: string;
  session_id: string;
  org_id: string | null;
  ticket_id: string | null;
  kind: CustomerPushKind;
  status: string;
  attempts: number;
  push_token: string | null;
  session_revoked: boolean;
  account_status: string;
  locale: 'ar' | 'en';
  ticket_status: string | null;
  venue_name_ar: string | null;
  venue_name_en: string | null;
}

/** The ticket states in which each kind still says something true (a late job sends nothing stale). */
const STILL_TRUE: Partial<Record<CustomerPushKind, ReadonlySet<string>>> = {
  car_received: new Set(['received', 'parking', 'parked', 'reparking']),
  request_accepted: new Set(['assigned', 'assigned_waiting', 'retrieving']),
  car_ready: new Set(['ready']),
  pickup_reminder: new Set(['ready']),
};

async function settle(
  db: Database,
  id: string,
  set: {
    status: 'sent' | 'delivered' | 'failed' | 'skipped';
    skipped?: string | null;
    provider?: string | null;
    receiptId?: string | null;
    error?: string | null;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `UPDATE customer_push_messages
        SET status = $2, skipped_reason = $3, provider = COALESCE($4, provider),
            provider_receipt_id = COALESCE($5, provider_receipt_id), error_code = $6, attempts = attempts + 1,
            sent_at = CASE WHEN $2 = 'sent' THEN $7::timestamptz ELSE sent_at END, updated_at = $7
      WHERE id = $1 AND status = 'pending'`,
    [
      id,
      set.status,
      set.skipped ?? null,
      set.provider ?? null,
      set.receiptId ?? null,
      set.error ?? null,
      set.at,
    ],
  );
}

/** A token the provider no longer knows is dropped from its session, wherever it still is (DEC-519). */
export async function pruneCustomerPushToken(db: Pick<Database, 'query'>, sessionId: string, token: string) {
  await db.query(
    `UPDATE customer_account_sessions SET push_token = NULL, push_provider = NULL, push_registered_at = NULL
      WHERE id = $1 AND push_token = $2`,
    [sessionId, token],
  );
}

export function customerPushSendHandler(runtime: () => CustomerPushRuntime): JobHandler {
  return {
    type: CUSTOMER_PUSH_SEND_JOB,
    mode: 'external',
    async handle(ctx) {
      const id = ctx.row.payload?.push_id;
      if (typeof id !== 'string') return;
      await sendPush(runtime(), ctx, id);
    },
  };
}

async function sendPush(rt: CustomerPushRuntime, ctx: JobContext, id: string): Promise<void> {
  const now = ctx.clock.now();
  const p = (
    await ctx.db.query<PushRow>(
      `SELECT m.id, m.account_id, m.session_id, m.org_id, m.ticket_id, m.kind, m.status, m.attempts,
              s.push_token, (s.revoked_at IS NOT NULL) AS session_revoked, a.status AS account_status, a.locale,
              t.status AS ticket_status, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en
         FROM customer_push_messages m
         JOIN customer_account_sessions s ON s.id = m.session_id
         JOIN customer_accounts a ON a.id = m.account_id
         LEFT JOIN tickets t ON t.id = m.ticket_id AND t.org_id = m.org_id
         LEFT JOIN venues v ON v.id = t.venue_id AND v.org_id = t.org_id
        WHERE m.id = $1`,
      [id],
    )
  ).rows[0];
  if (!p || p.status !== 'pending') return;
  if (p.account_status !== 'active')
    return settle(ctx.db, id, { status: 'skipped', skipped: 'account_unavailable', at: now });
  if (p.session_revoked)
    return settle(ctx.db, id, { status: 'skipped', skipped: 'session_revoked', at: now });
  if (!p.push_token) return settle(ctx.db, id, { status: 'skipped', skipped: 'no_token', at: now });
  const still = STILL_TRUE[p.kind];
  if (!p.ticket_id || !still || !still.has(p.ticket_status ?? ''))
    return settle(ctx.db, id, { status: 'skipped', skipped: 'stale', at: now });

  const content = customerPushContent({
    kind: p.kind,
    locale: p.locale === 'en' ? 'en' : 'ar',
    ticketId: p.ticket_id,
    brand: { ar: rt.env.BRAND_CUSTOMER_NAME_AR, en: rt.env.BRAND_CUSTOMER_NAME_EN },
    venue: p.venue_name_ar ? { ar: p.venue_name_ar, en: p.venue_name_en } : null,
  });
  const token = p.push_token;
  let ticket;
  try {
    [ticket] = await rt.sender.send([{ to: token, ...content }]);
  } catch (e) {
    const last = ctx.row.attempts + 1 >= ctx.row.max_attempts;
    if (e instanceof CustomerPushTransportError && e.retryable && !last)
      throw new RetryableJobError(e.message, backoffMs(ctx.row.attempts + 1));
    ctx.logger.warn({ push_id: id, kind: p.kind }, 'customer push not sent');
    return settle(ctx.db, id, {
      status: 'failed',
      provider: rt.sender.provider,
      error: e instanceof CustomerPushTransportError ? 'transport' : 'internal',
      at: ctx.clock.now(),
    });
  }
  if (!ticket || ticket.status !== 'ok') {
    const error = ticket?.status === 'error' ? (ticket.error ?? 'error') : 'no_ticket';
    if (error === DEVICE_NOT_REGISTERED) await pruneCustomerPushToken(ctx.db, p.session_id, token);
    ctx.logger.info({ push_id: id, kind: p.kind, provider_error: error }, 'customer push refused');
    return settle(ctx.db, id, { status: 'failed', provider: rt.sender.provider, error, at: ctx.clock.now() });
  }
  await settle(ctx.db, id, {
    status: 'sent',
    provider: rt.sender.provider,
    receiptId: ticket.id,
    at: ctx.clock.now(),
  });
  // the delivery receipt, later: one pending check per operator (the job reads every due row of it)
  if (p.org_id) await scheduleReceipts(ctx.db, rt.env, p.org_id, ctx.clock.now());
  ctx.logger.info({ push_id: id, kind: p.kind, provider: rt.sender.provider }, 'customer push sent');
}

async function scheduleReceipts(db: Database, env: Env, orgId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await schedule(
      tx,
      CUSTOMER_PUSH_RECEIPTS_JOB,
      new Date(now.getTime() + env.CUSTOMER_PUSH_RECEIPT_DELAY_S * 1000),
      {
        orgId,
        dedupeKey: `customer_push_receipts:${orgId}`,
        payload: { org_id: orgId },
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// job.customer_push_receipts — the provider's delivery receipts; invalid tokens pruned
// ---------------------------------------------------------------------------------------------

/** Receipts older than this are not kept by the provider: the row stays `sent`, its receipt marked checked. */
const RECEIPT_GIVE_UP_MS = 24 * 3600_000;

export function customerPushReceiptsHandler(runtime: () => CustomerPushRuntime): JobHandler {
  return {
    type: CUSTOMER_PUSH_RECEIPTS_JOB,
    mode: 'external',
    async handle(ctx) {
      const orgId = ctx.row.payload?.org_id;
      if (typeof orgId !== 'string') return;
      await checkReceipts(runtime(), ctx, orgId);
    },
  };
}

async function checkReceipts(rt: CustomerPushRuntime, ctx: JobContext, orgId: string): Promise<void> {
  const now = ctx.clock.now();
  const due = new Date(now.getTime() - rt.env.CUSTOMER_PUSH_RECEIPT_DELAY_S * 1000);
  const rows = (
    await ctx.db.query<{ id: string; session_id: string; provider_receipt_id: string; sent_at: Date }>(
      `SELECT id, session_id, provider_receipt_id, sent_at FROM customer_push_messages
        WHERE org_id = $1 AND status = 'sent' AND provider_receipt_id IS NOT NULL AND receipt_checked_at IS NULL
          AND sent_at <= $2
        ORDER BY sent_at, id LIMIT $3`,
      [orgId, due, EXPO_PUSH_RECEIPTS_LIMIT],
    )
  ).rows;
  if (rows.length === 0) return;
  let receipts;
  try {
    receipts = await rt.sender.receipts(rows.map((r) => r.provider_receipt_id));
  } catch (e) {
    if (e instanceof CustomerPushTransportError && e.retryable)
      throw new RetryableJobError(e.message, backoffMs(ctx.row.attempts + 1));
    throw e;
  }
  for (const r of rows) {
    const receipt = receipts[r.provider_receipt_id];
    if (!receipt) {
      if (now.getTime() - new Date(r.sent_at).getTime() >= RECEIPT_GIVE_UP_MS)
        await ctx.db.query(
          `UPDATE customer_push_messages SET receipt_checked_at = $2, updated_at = $2 WHERE id = $1`,
          [r.id, now],
        );
      continue;
    }
    if (receipt.status === 'ok') {
      await ctx.db.query(
        `UPDATE customer_push_messages SET status = 'delivered', receipt_status = 'ok', receipt_checked_at = $2,
                updated_at = $2 WHERE id = $1 AND status = 'sent'`,
        [r.id, now],
      );
      continue;
    }
    const error = receipt.error ?? 'error';
    await ctx.db.transaction(async (tx) => {
      const m = await tx.maybeOne<{ token: string | null }>(
        `UPDATE customer_push_messages m SET status = 'failed', receipt_status = 'error', error_code = $2,
                receipt_checked_at = $3, updated_at = $3
           FROM customer_account_sessions s
          WHERE m.id = $1 AND m.status = 'sent' AND s.id = m.session_id
          RETURNING s.push_token AS token`,
        [r.id, error, now],
      );
      if (error === DEVICE_NOT_REGISTERED && m?.token)
        await pruneCustomerPushToken(tx, r.session_id, m.token);
    });
  }
  // more due rows than one call reads: the next page right away; rows not yet due: when the first one is
  const left = (
    await ctx.db.query<{ n: number; first: Date | null }>(
      `SELECT count(*)::int AS n, min(sent_at) AS first FROM customer_push_messages
        WHERE org_id = $1 AND status = 'sent' AND provider_receipt_id IS NOT NULL AND receipt_checked_at IS NULL`,
      [orgId],
    )
  ).rows[0];
  if (left && left.n > 0 && left.first) {
    const at = new Date(
      Math.max(
        now.getTime() + 1000,
        new Date(left.first).getTime() + rt.env.CUSTOMER_PUSH_RECEIPT_DELAY_S * 1000,
      ),
    );
    await ctx.db.transaction((tx) =>
      // no dedupe key: this row is still `processing` under the key the senders use (a twin is harmless)
      schedule(tx, CUSTOMER_PUSH_RECEIPTS_JOB, at, { orgId, payload: { org_id: orgId } }).then(
        () => undefined,
      ),
    );
  }
}
