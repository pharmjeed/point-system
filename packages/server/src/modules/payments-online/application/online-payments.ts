import { vatOfInclusive, type OnlinePaymentPurpose } from '@point/shared';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  retryableFailure,
  type GatewayResult,
  type GatewaySource,
  type CreatedPayment,
} from '../domain/gateway.js';
import type { PaymentsRuntime } from '../runtime.js';
import { applyGatewayPayment, paymentById, type OnlinePaymentRow } from './payment-sync.js';
import { subscriptionPaymentHook } from './subscription-hook.js';

export interface StartPaymentInput {
  accountId: string;
  purpose: OnlinePaymentPurpose;
  /** visit: the ticket, its operator and venue (settlement, V2-041) */
  ticketId?: string | null;
  orgId?: string | null;
  venueId?: string | null;
  /** subscription (V2-031): the subscription and the period this payment pays */
  subscriptionId?: string | null;
  subscriptionPeriodSeq?: number | null;
  /** VAT included (04 §4); the VAT part is computed here */
  amountHalalas: number;
  source: GatewaySource | { type: 'saved'; paymentMethodId: string; token: string };
  /** the app's return page after 3-D Secure (it changes nothing by itself, DEC-512) */
  callbackUrl: string;
  requestId?: string | null;
}

export interface StartedPayment {
  payment: OnlinePaymentRow;
  /** the gateway's 3-D Secure page, when it asks for one */
  actionUrl: string | null;
}

/**
 * Starting an online payment (the server side of C-10/C-12, used by V2-022 and V2-023; DEC-512), network-then-commit
 * in three steps so that no network call ever runs inside a transaction (canon rule 3):
 * 1. a transaction writes the `initiated` row with a fresh `given_id` (the gateway's idempotency key) and its audit;
 * 2. the gateway is called outside any transaction, with ids only in its metadata;
 * 3. a transaction applies the gateway's answer to the locked row (applyGatewayPayment) — `paid` or `failed` at
 *    once for a frictionless card, `initiated` with a 3-D Secure page otherwise; the signed webhook (confirmed by a
 *    fetch) moves it on later. A declined payment answers PAYMENT_FAILED after its state is committed; a gateway that
 *    cannot be reached leaves the row `initiated` (DEPENDENCY_TIMEOUT / SERVICE_UNAVAILABLE) and `resume` sends the
 *    same given_id again, which the gateway never charges twice.
 */
export class OnlinePayments {
  constructor(
    private readonly db: Database,
    private readonly rt: PaymentsRuntime,
  ) {}

  async start(input: StartPaymentInput): Promise<StartedPayment> {
    const id = newId();
    await this.db.transaction((tx) => this.begin(tx, { ...input, id, givenId: newId() }));
    return this.send(id, input);
  }

  /** Steps 2 and 3 for a row written by `begin` once its transaction committed (V2-022, DEC-521). */
  sendInitiated(
    id: string,
    input: Pick<
      StartPaymentInput,
      'source' | 'callbackUrl' | 'amountHalalas' | 'purpose' | 'ticketId' | 'subscriptionId'
    >,
  ): Promise<StartedPayment> {
    return this.send(id, input);
  }

  /**
   * Step 1 inside the caller's transaction: the `initiated` row with its given_id and its audit. The pay command
   * of V2-022 writes it under the ticket lock, with its checks (DEC-521), then calls `sendInitiated` after COMMIT.
   */
  async begin(tx: Tx, input: StartPaymentInput & { id: string; givenId: string }): Promise<void> {
    const { id, givenId } = input;
    const sourceType = input.source.type === 'saved' ? 'token' : input.source.type;
    {
      await tx.query(
        `INSERT INTO online_payments (id, account_id, purpose, subscription_id, ticket_id, org_id, venue_id,
                                      payment_method_id, amount_halalas, vat_halalas, gateway, given_id, source_type,
                                      created_at, updated_at, subscription_period_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15)`,
        [
          id,
          input.accountId,
          input.purpose,
          input.subscriptionId ?? null,
          input.ticketId ?? null,
          input.orgId ?? null,
          input.venueId ?? null,
          input.source.type === 'saved' ? input.source.paymentMethodId : null,
          input.amountHalalas,
          vatOfInclusive(input.amountHalalas),
          this.rt.gateway.name,
          givenId,
          sourceType,
          tx.now,
          input.subscriptionPeriodSeq ?? null,
        ],
      );
      const metadata = {
        purpose: input.purpose,
        amount_halalas: input.amountHalalas,
        source_type: sourceType,
        ticket_id: input.ticketId ?? null,
        ...(input.subscriptionId
          ? {
              subscription_id: input.subscriptionId,
              subscription_period_seq: input.subscriptionPeriodSeq ?? null,
            }
          : {}),
      };
      await customerAudit(tx, {
        actor: { type: 'customer', accountId: input.accountId },
        action: 'online_payment.initiated',
        entityType: 'online_payment',
        entityId: id,
        requestId: input.requestId ?? null,
        metadata,
      });
      await platformAudit(tx, {
        actor: { type: 'system', id: null, name: 'payments' },
        action: 'online_payment.initiated',
        entityType: 'online_payment',
        entityId: id,
        // a subscription payment is POINT's alone: not in the operator's audit_log (DEC-534)
        orgId: input.purpose === 'visit' ? (input.orgId ?? null) : null,
        requestId: input.requestId ?? null,
        metadata,
      });
    }
  }

  /** Sends an `initiated` row that never reached the gateway again, with its own given_id. */
  async resume(
    paymentId: string,
    input: Pick<StartPaymentInput, 'source' | 'callbackUrl'>,
  ): Promise<StartedPayment> {
    const row = await paymentById(this.db, paymentId);
    if (!row) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'online_payment' });
    if (row.status !== 'initiated' || row.gateway_payment_id)
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'online_payment',
        entity_id: row.id,
        current_status: row.status,
        command: 'online_payment.resume',
      });
    return this.send(row.id, {
      ...input,
      amountHalalas: row.amount_halalas,
      purpose: row.purpose,
      ticketId: row.ticket_id,
    });
  }

  private async send(
    id: string,
    input: Pick<
      StartPaymentInput,
      'source' | 'callbackUrl' | 'amountHalalas' | 'purpose' | 'ticketId' | 'subscriptionId'
    >,
  ): Promise<StartedPayment> {
    const row = (await paymentById(this.db, id))!;
    const common = {
      givenId: row.given_id,
      amountHalalas: input.amountHalalas,
      description: `${this.rt.env.BRAND_CUSTOMER_NAME_EN} ${input.purpose} ${id}`,
      callbackUrl: input.callbackUrl,
      metadata: {
        online_payment_id: id,
        purpose: input.purpose,
        ...(input.ticketId ? { ticket_id: input.ticketId } : {}),
        ...(input.subscriptionId ? { subscription_id: input.subscriptionId } : {}),
      },
    };
    const res: GatewayResult<CreatedPayment> =
      input.source.type === 'saved'
        ? await this.rt.gateway.chargeSavedMethod({ ...common, token: input.source.token })
        : await this.rt.gateway.createPayment({ ...common, source: input.source });
    if (!res.ok) {
      // unreachable, or not usable by us (key missing, a live key outside production, our key refused): the payment
      // never reached the gateway and stays `initiated`, to be resumed with the same given_id
      if (retryableFailure(res) || res.kind === 'refused' || res.status === 401 || res.status === 403) {
        this.rt.logger.warn(
          { online_payment_id: id, kind: res.kind, status: res.status },
          'gateway unreachable',
        );
        throw new AppError(res.kind === 'timeout' ? 'DEPENDENCY_TIMEOUT' : 'SERVICE_UNAVAILABLE', {
          online_payment_id: id,
        });
      }
      // refused by the gateway (validation, a token it does not know …): no payment exists there
      const failureCode =
        `gateway_${(res.type ?? `http_${res.status ?? 'refused'}`).replace(/[^A-Za-z0-9_]/g, '_')}`.slice(
          0,
          64,
        );
      await this.db.transaction(async (tx) => {
        const r = await tx.maybeOne<{ id: string }>(
          `UPDATE online_payments SET status = 'failed', failed_at = $2, failure_code = $3, version = version + 1
            WHERE id = $1 AND status = 'initiated' RETURNING id`,
          [id, tx.now, failureCode],
        );
        if (!r) return;
        const metadata = {
          from_status: 'initiated',
          to_status: 'failed',
          failure_code: failureCode,
          cause: 'create',
        };
        await platformAudit(tx, {
          actor: { type: 'system', id: null, name: 'payments' },
          action: 'online_payment.failed',
          entityType: 'online_payment',
          entityId: id,
          orgId: row.purpose === 'visit' ? row.org_id : null,
          metadata,
        });
        await customerAudit(tx, {
          actor: { type: 'system', name: 'payments' },
          action: 'online_payment.failed',
          entityType: 'online_payment',
          entityId: id,
          accountId: row.account_id,
          metadata,
        });
        // V2-031: a refused renewal is a failed attempt of its subscription (DEC-533)
        const sub = row.purpose === 'subscription' ? subscriptionPaymentHook() : null;
        if (sub) await sub.afterFailed(tx, (await paymentById(tx, id))!);
      });
      throw new AppError('PAYMENT_FAILED', { online_payment_id: id, failure_code: failureCode });
    }
    const created = res.value;
    const payment = await this.db.transaction(async (tx) => {
      const locked = (await paymentById(tx, id, true))!;
      return (await applyGatewayPayment(tx, locked, created.payment, { kind: 'create' })).payment;
    });
    if (payment.status === 'failed')
      throw new AppError('PAYMENT_FAILED', { online_payment_id: id, failure_code: payment.failure_code });
    return { payment, actionUrl: payment.status === 'initiated' ? created.actionUrl : null };
  }
}
