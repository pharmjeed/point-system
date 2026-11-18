import type { GatewayWebhookOutcome } from '@point/shared';
import { PAYMENT_WEBHOOK_PROCESS_JOB } from '../domain/jobs.js';
import { raisePlatformAlert } from '../../../core/alerts/platform-alerts.js';
import { killPoint } from '../../../core/chaos/kill-points.js';
import { sha256Hex } from '../../../core/crypto/crypto.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { RetryableJobError, backoffMs, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import { retryableFailure } from '../domain/gateway.js';
import type { PaymentsRuntime } from '../runtime.js';
import { applyGatewayPayment, paymentOfGateway } from './payment-sync.js';
import { platformOrgId } from './platform-org.js';

export interface StoredWebhook {
  id: string | null;
  duplicate: boolean;
}

/**
 * `POST /webhooks/payments/moyasar` (V2-021, DEC-511, DEC-512), the WhatsApp intake's pattern (12 §6.2): the raw body
 * is verified before anything else is read (the gateway's shared secret, compared in constant time), stored once per
 * (gateway, event id) with its secret removed and its card fields reduced, and `job.payment_webhook_process` is
 * queued in the same transaction; the gateway gets 200 at once, a redelivery included. Nothing is decided here: the
 * worker processes the event.
 */
export class PaymentWebhookIntake {
  constructor(
    private readonly rt: PaymentsRuntime,
    private readonly db: Database,
  ) {}

  async receive(raw: Buffer | undefined): Promise<StoredWebhook> {
    const body = raw ?? Buffer.alloc(0);
    const v = await this.rt.gateway.verifyWebhook(body);
    if (!v.ok) {
      if (v.reason === 'not_configured') {
        // nothing to verify against: the gateway retries the delivery while the secret is being set
        this.rt.logger.error('payment webhook received but no webhook secret is configured');
        throw new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 60 });
      }
      metrics.paymentWebhooks.inc({ outcome: 'rejected' });
      if (v.reason === 'malformed')
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ field: '(body)', issue: 'missing_event_id_or_type' }],
        });
      this.rt.logger.warn({ body_bytes: body.length, reason: v.reason }, 'payment webhook refused');
      throw new AppError('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    }
    const e = v.event;
    const orgId = await platformOrgId(this.db);
    if (!orgId) throw new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 60 });
    const stored = await this.db.transaction(async (tx) => {
      const r = await tx.maybeOne<{ id: string }>(
        `INSERT INTO gateway_webhook_events (gateway, event_id, event_type, gateway_payment_id, live, body_sha256,
                                             payload, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (gateway, event_id) DO NOTHING RETURNING id::text AS id`,
        [
          this.rt.gateway.name,
          e.id.slice(0, 200),
          e.type.slice(0, 100),
          e.paymentId,
          e.live,
          sha256Hex(body),
          JSON.stringify(e.sanitized),
          tx.now,
        ],
      );
      if (r)
        await enqueue(tx, {
          type: PAYMENT_WEBHOOK_PROCESS_JOB,
          orgId,
          dedupeKey: `payment_webhook:${r.id}`,
          // one payment's events one after the other (each one reads the gateway's record anyway)
          orderingKey: e.paymentId ? `payment:${e.paymentId}` : null,
          payload: { webhook_event_id: r.id },
        });
      return { id: r?.id ?? null, duplicate: !r };
    });
    metrics.paymentWebhooks.inc({ outcome: stored.duplicate ? 'duplicate' : 'stored' });
    this.rt.logger.debug(
      { webhook_event_id: stored.id, event_type: e.type, duplicate: stored.duplicate },
      'payment webhook stored',
    );
    return stored;
  }
}

interface WebhookEventRow {
  id: string;
  gateway: string;
  event_id: string;
  event_type: string;
  gateway_payment_id: string | null;
  processed_at: Date | null;
}

async function finish(
  tx: Tx,
  id: string,
  outcome: GatewayWebhookOutcome,
  paymentId: string | null = null,
): Promise<void> {
  await tx.query(
    `UPDATE gateway_webhook_events SET processed_at = $2, outcome = $3, online_payment_id = $4
      WHERE id = $1 AND processed_at IS NULL`,
    [id, tx.now, outcome, paymentId],
  );
}

/**
 * `job.payment_webhook_process` (mode external, DEC-512): processes one stored delivery exactly once. The event's
 * own `data` is never trusted: the worker fetches the payment from the gateway (an authenticated call, outside any
 * transaction) and applies that record, so a replay, a late or an out-of-order event converge on the gateway's
 * truth and the machine only moves forward. A payment the platform does not know is recorded (outcome
 * `unknown_payment`) and raises the `payment_unknown` platform alert; a payment the gateway does not know
 * (`not_at_gateway`) too.
 */
export function paymentWebhookJob(runtime: () => PaymentsRuntime): JobHandler {
  return {
    type: PAYMENT_WEBHOOK_PROCESS_JOB,
    mode: 'external',
    async handle({ row, db }) {
      const id = row.payload?.webhook_event_id;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      const rt = runtime();
      const ev = (
        await db.query<WebhookEventRow>(
          `SELECT id::text AS id, gateway, event_id, event_type, gateway_payment_id, processed_at
             FROM gateway_webhook_events WHERE id = $1`,
          [String(id)],
        )
      ).rows[0];
      if (!ev || ev.processed_at) return;
      if (!ev.gateway_payment_id) {
        await db.transaction((tx) => finish(tx, ev.id, 'ignored'));
        return;
      }
      const fetched = await rt.gateway.fetchPayment(ev.gateway_payment_id);
      if (!fetched.ok && !(fetched.kind === 'http' && fetched.status === 404)) {
        // the gateway cannot answer now (or its key is missing): retried with backoff, dead-lettered at the end
        // (outbox_lag watches dead rows, 15 §12)
        const why = retryableFailure(fetched) ? fetched.kind : `refused ${fetched.status ?? ''}`.trim();
        throw new RetryableJobError(`payment fetch failed: ${why}`, backoffMs(row.attempts));
      }
      await db.transaction(async (tx) => {
        const locked = await tx.maybeOne<{ processed_at: Date | null }>(
          `SELECT processed_at FROM gateway_webhook_events WHERE id = $1 FOR UPDATE`,
          [ev.id],
        );
        if (!locked || locked.processed_at) return;
        if (!fetched.ok) {
          await raisePlatformAlert(tx, {
            type: 'payment_unknown',
            dedupeKey: `payment_unknown:${ev.gateway_payment_id}`,
            details: {
              gateway_payment_id: ev.gateway_payment_id,
              reason: 'not_at_gateway',
              event_type: ev.event_type,
              webhook_event_id: ev.id,
            },
          });
          return finish(tx, ev.id, 'not_at_gateway');
        }
        const gp = fetched.value;
        const payment = await paymentOfGateway(tx, ev.gateway, gp, true);
        if (!payment) {
          await raisePlatformAlert(tx, {
            type: 'payment_unknown',
            dedupeKey: `payment_unknown:${gp.id}`,
            details: {
              gateway_payment_id: gp.id,
              reason: 'unknown_at_point',
              gateway_status: gp.status,
              amount_halalas: gp.amount,
              event_type: ev.event_type,
              webhook_event_id: ev.id,
            },
          });
          rt.logger.warn(
            { webhook_event_id: ev.id, event_type: ev.event_type },
            'payment webhook for an unknown payment',
          );
          return finish(tx, ev.id, 'unknown_payment');
        }
        const r = await applyGatewayPayment(tx, payment, gp, {
          kind: 'webhook',
          eventId: ev.event_id,
          eventType: ev.event_type,
        });
        return finish(tx, ev.id, r.outcome, payment.id);
      });
      // V2-051 (DEC-561, KP-6): the event is processed and committed, the outbox row not yet `done`
      killPoint('payment_webhook_after_commit_before_done');
    },
  };
}
