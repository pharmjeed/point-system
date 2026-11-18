import {
  planPrice,
  purchaseConsentRequired,
  SUBSCRIPTION_RULES,
  vatOfInclusive,
  type OnlinePaymentStatus,
} from '@point/shared';
import {
  CustomerSubscribeBodySchema,
  CustomerSubscriptionPayBodySchema,
  type CustomerPaymentSource,
  type CustomerPurchaseConsent,
  type CustomerSubscribeBody,
  type CustomerSubscriptionCheckout,
} from '@point/shared/customer';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import type { Env } from '../../../core/config/env.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import {
  OnlinePayments,
  retryableFailure,
  type GatewaySource,
  type GatewayToken,
  type PaymentsRuntime,
} from '../../payments-online/index.js';
import { checkoutGivenId } from '../domain/jobs.js';
import { auditTransition, publishSubscriptionUpdated, schedulePendingExpiry } from './machine.js';
import {
  planById,
  policyOf,
  seatsTakenSql,
  subscriptionById,
  UUID,
  type PlanPolicyRow,
  type PlanRow,
  type Q,
  type SubscriptionRow,
} from './rows.js';
import { customerSubscriptions, subscriptionPaymentRow, subscriptionPaymentView } from './views.js';

/** What the network phase of a checkout left for the command transaction (DEC-96 pattern, as V2-022's pay). */
export type CheckoutPlan =
  | { kind: 'payment'; subscriptionId: string; paymentId: string; transactionUrl: string | null }
  | { kind: 'error'; error: AppError };

type Source = GatewaySource | { type: 'saved'; paymentMethodId: string; token: string };

const MIN = SUBSCRIPTION_RULES.pending_payment_minutes * 60_000;

/** The account row FOR NO KEY UPDATE: the first lock of every customer subscription command (after its key). */
export async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  const r = await tx.maybeOne<{ status: string }>(
    `SELECT status FROM customer_accounts WHERE id = $1 FOR NO KEY UPDATE`,
    [accountId],
  );
  if (!r) throw new AppError('AUTH_UNAUTHENTICATED');
  if (r.status === 'deleted') throw new AppError('ACCOUNT_DELETED');
  if (r.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
}

/** The explicit consent a saved card needs (DEC-524), as in the visit's pay command. */
function assertCardConsent(env: Env, version: string | undefined): void {
  const current = env.CUSTOMER_CARD_ON_FILE_VERSION;
  if (!version)
    throw new AppError('CUSTOMER_CONSENT_REQUIRED', { kind: 'card_on_file', current_version: current });
  if (version !== current)
    throw new AppError('CUSTOMER_CONSENT_VERSION_STALE', { kind: 'card_on_file', current_version: current });
}

/** A device-tokenized card read at the gateway (network: before any transaction, DEC-524). */
async function readToken(rt: PaymentsRuntime, token: string): Promise<GatewayToken> {
  const r = await rt.gateway.fetchToken(token);
  if (!r.ok) {
    if (retryableFailure(r) || r.kind === 'refused')
      throw new AppError(r.kind === 'timeout' ? 'DEPENDENCY_TIMEOUT' : 'SERVICE_UNAVAILABLE');
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'token', issue: 'unknown_token' }] });
  }
  if (r.value.status !== 'active')
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'token', issue: 'not_active' }] });
  return r.value;
}

const brandOf = (b: string | null) => (b && /^[a-z_]{2,20}$/.test(b) ? b : null);
const monthOf = (m: number | null) => (m !== null && m >= 1 && m <= 12 ? m : null);
const yearOf = (y: number | null) => (y !== null && y >= 2000 && y <= 2100 ? y : null);

/**
 * The automatic renewals charge a saved card (DEC-534): a saved card of C-18, or a card tokenized on the device kept
 * with `save_card` (and its consent); an Apple Pay token or a card not kept cannot be charged again. A plan renewed by
 * hand is never charged again (DEC-595): any source pays it, Apple Pay and a card not kept included.
 */
async function sourceOf(
  q: Q,
  accountId: string,
  source: CustomerPaymentSource,
  saveCard: boolean | undefined,
  manualRenewal = false,
): Promise<Source> {
  if (source.type === 'applepay') {
    if (manualRenewal) return source;
    throw new AppError('SUBSCRIPTION_CARD_REQUIRED', { source_type: 'applepay' });
  }
  if (source.type === 'token') {
    if (!saveCard && !manualRenewal)
      throw new AppError('SUBSCRIPTION_CARD_REQUIRED', { source_type: 'token' });
    return source;
  }
  const r = await q.query<{ id: string; gateway_token: string }>(
    `SELECT id, gateway_token FROM customer_payment_methods
      WHERE id = $1 AND account_id = $2 AND removed_at IS NULL AND pending_payment_id IS NULL`,
    [source.payment_method_id, accountId],
  );
  const m = r.rows[0];
  if (!m) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'payment_method' });
  return { type: 'saved', paymentMethodId: m.id, token: m.gateway_token };
}

interface SellableRow {
  plan_status: string;
  vehicles_included: number;
  monthly_price_halalas: number | null;
  yearly_price_halalas: number | null;
  venue_id: string;
  org_id: string;
  listed: boolean;
  subscriptions_enabled: boolean;
  category: string;
}

/**
 * Subscribing (C-09 → C-10) and paying a subscription waiting for its payment or in its grace (C-14 «ادفع»): V2-032,
 * DEC-532, DEC-534. Network then commit as the visit's pay command (DEC-96, DEC-521): the route guard runs `prepare`
 * before the command transaction — the card read at the gateway, one transaction writing the subscription (or
 * locking it) with the `initiated` payment, then the gateway call — and the handler answers its plan inside the
 * command transaction, so a deterministic 4xx is stored with the Idempotency-Key and a 5xx is not. The given_id of the
 * payment is derived from the account and the key: a retried or concurrent request with one key never charges twice.
 * The period starts when the payment is paid (the hook of payments-online, onSubscriptionPaid), not here.
 */
export class SubscriptionCheckout {
  private readonly payments: OnlinePayments;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly rt: PaymentsRuntime,
  ) {
    this.payments = new OnlinePayments(db, rt);
  }

  async prepare(
    mode: { kind: 'subscribe' } | { kind: 'pay'; subscriptionId: string },
    accountId: string,
    raw: unknown,
    idempotencyKey: string,
    requestId: string | null,
  ): Promise<CheckoutPlan | undefined> {
    const parsed =
      mode.kind === 'subscribe'
        ? CustomerSubscribeBodySchema.safeParse(raw ?? {})
        : CustomerSubscriptionPayBodySchema.safeParse(raw ?? {});
    if (!parsed.success) return undefined; // the body pipe answers VALIDATION_FAILED
    const body = parsed.data;
    try {
      if (mode.kind === 'pay' && !UUID.test(mode.subscriptionId))
        throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
      const givenId = checkoutGivenId(mode.kind, accountId, idempotencyKey);
      const prior = (
        await this.db.query<{
          id: string;
          subscription_id: string;
          status: OnlinePaymentStatus;
          gateway_payment_id: string | null;
          amount_halalas: number;
        }>(
          `SELECT id, subscription_id, status, gateway_payment_id, amount_halalas::float8 AS amount_halalas
             FROM online_payments WHERE given_id = $1 AND account_id = $2`,
          [givenId, accountId],
        )
      ).rows[0];
      if (prior) {
        if (prior.status === 'initiated' && !prior.gateway_payment_id) {
          const manual = (await manualRenewalOf(this.db, prior.subscription_id)) ?? false;
          const url = await this.send(prior.subscription_id, prior.id, {
            source: await sourceOf(this.db, accountId, body.source, body.save_card, manual),
            amountHalalas: prior.amount_halalas,
          });
          return payment(prior.subscription_id, prior.id, url);
        }
        return payment(prior.subscription_id, prior.id, null);
      }
      let card: GatewayToken | null = null;
      if (body.save_card && body.source.type === 'token') {
        assertCardConsent(this.env, body.card_on_file_version);
        card = await readToken(this.rt, body.source.token);
      }
      const paymentId = newId();
      const written = await this.db.transaction((tx) =>
        mode.kind === 'subscribe'
          ? this.writeSubscribe(tx, accountId, body as CustomerSubscribeBody, {
              givenId,
              paymentId,
              card,
              requestId,
            })
          : this.writePay(tx, accountId, mode.subscriptionId, body, { givenId, paymentId, card, requestId }),
      );
      if ('twin' in written) return payment(written.subscriptionId, written.twin, null);
      const url = await this.send(written.subscriptionId, paymentId, {
        source: written.source,
        amountHalalas: written.amount,
      });
      return payment(written.subscriptionId, paymentId, url);
    } catch (e) {
      if (e instanceof AppError) return { kind: 'error', error: e };
      throw e;
    }
  }

  /**
   * The gateway call; a declined card names the subscription too (PAYMENT_FAILED's details): the subscription waits
   * for another card (`pending_payment` for its 30 minutes, or `past_due` in its grace) through `…/pay`.
   */
  private async send(
    subscriptionId: string,
    paymentId: string,
    input: { source: Source; amountHalalas: number },
  ): Promise<string | null> {
    try {
      const sent = await this.payments.sendInitiated(paymentId, {
        ...input,
        callbackUrl: this.env.CUSTOMER_PAY_CALLBACK_URL,
        purpose: 'subscription',
        subscriptionId,
      });
      return sent.actionUrl;
    } catch (e) {
      if (e instanceof AppError && e.code === 'PAYMENT_FAILED')
        throw new AppError('PAYMENT_FAILED', { ...e.details, subscription_id: subscriptionId });
      throw e;
    }
  }

  private async writeSubscribe(
    tx: Tx,
    accountId: string,
    body: {
      plan_id: string;
      billing_cycle: 'monthly' | 'yearly';
      vehicle_ids: string[];
      source: CustomerPaymentSource;
      save_card?: boolean | undefined;
      purchase_consent?: CustomerPurchaseConsent | undefined;
    },
    w: { givenId: string; paymentId: string; card: GatewayToken | null; requestId: string | null },
  ): Promise<
    { twin: string; subscriptionId: string } | { source: Source; amount: number; subscriptionId: string }
  > {
    await lockAccount(tx, accountId);
    const twin = await tx.maybeOne<{ id: string; subscription_id: string }>(
      `SELECT id, subscription_id FROM online_payments WHERE given_id = $1`,
      [w.givenId],
    );
    if (twin) return { twin: twin.id, subscriptionId: twin.subscription_id };
    const plan = await planById(tx, body.plan_id);
    if (!plan) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription_plan' });
    const sale = await tx.one<SellableRow>(
      `SELECT p.status AS plan_status, p.vehicles_included, p.monthly_price_halalas::float8 AS monthly_price_halalas,
              p.yearly_price_halalas::float8 AS yearly_price_halalas, p.venue_id, p.org_id,
              (vp.status = 'approved' AND v.status = 'active' AND o.operator_status = 'active') AS listed,
              COALESCE(vp.subscriptions_enabled, false) AS subscriptions_enabled, COALESCE(vp.category, 'other') AS category
         FROM subscription_plans p
         JOIN venues v ON v.id = p.venue_id AND v.org_id = p.org_id
         JOIN organizations o ON o.id = p.org_id
         LEFT JOIN venue_public_profiles vp ON vp.venue_id = p.venue_id AND vp.org_id = p.org_id
        WHERE p.id = $1`,
      [plan.id],
    );
    if (!sale.listed) throw new AppError('VENUE_NOT_LISTED');
    if (!sale.subscriptions_enabled || sale.category === 'hall')
      throw new AppError('SUBSCRIPTION_PLAN_UNAVAILABLE', { reason: 'not_sold' });
    if (sale.plan_status !== 'active')
      throw new AppError('SUBSCRIPTION_PLAN_UNAVAILABLE', { reason: 'retired' });
    const price = planPrice(sale, body.billing_cycle);
    if (price === null) throw new AppError('SUBSCRIPTION_PLAN_UNAVAILABLE', { reason: 'cycle' });
    // 04 §7 (DEC-596): a plan checked for eligibility is applied for first and paid once approved
    if (plan.eligibility !== 'none')
      throw new AppError('SUBSCRIPTION_ELIGIBILITY_REQUIRED', {
        plan_id: plan.id,
        eligibility: plan.eligibility,
      });
    const consent = assertPurchaseConsent(this.env, plan, body.purchase_consent);
    if (body.vehicle_ids.length > sale.vehicles_included)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'vehicle_ids', issue: 'too_many', max: sale.vehicles_included }],
      });
    await assertOwnVehicles(tx, accountId, body.vehicle_ids);
    const live = await tx.maybeOne<{ id: string; status: string }>(
      `SELECT id, status FROM subscriptions
        WHERE account_id = $1 AND venue_id = $2 AND org_id = $3
          AND status IN ('pending_eligibility','pending_payment','active','past_due','frozen')`,
      [accountId, sale.venue_id, sale.org_id],
    );
    if (live)
      throw new AppError('SUBSCRIPTION_ALREADY_EXISTS', { subscription_id: live.id, status: live.status });
    await assertCapacity(tx, plan, null);
    const source = await sourceOf(tx, accountId, body.source, body.save_card, plan.renewal_mode === 'manual');
    const subId = newId();
    const sub = await tx.one<SubscriptionRow>(
      `INSERT INTO subscriptions (id, account_id, plan_id, org_id, venue_id, billing_cycle, status, price_halalas,
                                  vehicles_included, pending_expires_at, payment_method_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment', $7, $8, $9, $10, $11, $11)
       RETURNING id, account_id, org_id, venue_id, status, version, pending_expires_at`,
      [
        subId,
        accountId,
        plan.id,
        sale.org_id,
        sale.venue_id,
        body.billing_cycle,
        price,
        sale.vehicles_included,
        new Date(tx.now.getTime() + MIN),
        source.type === 'saved' ? source.paymentMethodId : null,
        tx.now,
      ],
    );
    for (const v of body.vehicle_ids)
      await tx.query(
        `INSERT INTO subscription_vehicles (subscription_id, account_id, customer_vehicle_id, added_at)
         VALUES ($1, $2, $3, $4)`,
        [subId, accountId, v, tx.now],
      );
    await this.beginPayment(tx, accountId, sub, {
      ...w,
      source,
      amount: price,
      seq: 1,
      saveCard: body.save_card,
      consent: consent ? { ...consent, planId: plan.id } : null,
    });
    await auditTransition(
      tx,
      sub,
      'subscription.subscribe',
      { type: 'customer', accountId, requestId: w.requestId },
      {
        from_status: null,
        to_status: 'pending_payment',
        plan_id: plan.id,
        billing_cycle: body.billing_cycle,
        price_halalas: price,
        vehicles: body.vehicle_ids.length,
        online_payment_id: w.paymentId,
      },
    );
    await schedulePendingExpiry(tx, sub);
    await publishSubscriptionUpdated(tx, sub);
    return { source, amount: price, subscriptionId: subId };
  }

  private async writePay(
    tx: Tx,
    accountId: string,
    subscriptionId: string,
    body: {
      source: CustomerPaymentSource;
      save_card?: boolean | undefined;
      purchase_consent?: CustomerPurchaseConsent | undefined;
    },
    w: { givenId: string; paymentId: string; card: GatewayToken | null; requestId: string | null },
  ): Promise<
    { twin: string; subscriptionId: string } | { source: Source; amount: number; subscriptionId: string }
  > {
    await lockAccount(tx, accountId);
    const sub = await subscriptionById(tx, subscriptionId, true);
    if (!sub || sub.account_id !== accountId)
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
    const twin = await tx.maybeOne<{ id: string }>(`SELECT id FROM online_payments WHERE given_id = $1`, [
      w.givenId,
    ]);
    if (twin) return { twin: twin.id, subscriptionId };
    if (sub.status !== 'pending_payment' && sub.status !== 'past_due')
      throw new AppError('SUBSCRIPTION_NOT_ACTIVE', {
        subscription_id: sub.id,
        current_status: sub.status,
        command: 'subscription.pay',
      });
    const seq = sub.periods_paid + 1;
    const pending = await tx.maybeOne<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM online_payments
        WHERE subscription_id = $1 AND subscription_period_seq = $2 AND status IN ('initiated','authorized')
          AND created_at > $3 AND org_id = $4
        ORDER BY created_at DESC LIMIT 1`,
      [sub.id, seq, new Date(tx.now.getTime() - this.env.VISIT_PAYMENT_PENDING_S * 1000), sub.org_id],
    );
    if (pending)
      throw new AppError('PAYMENT_IN_PROGRESS', {
        online_payment_id: pending.id,
        retry_after_s: Math.max(
          1,
          Math.ceil(
            (new Date(pending.created_at).getTime() +
              this.env.VISIT_PAYMENT_PENDING_S * 1000 -
              tx.now.getTime()) /
              1000,
          ),
        ),
      });
    // the first term (an approved application, or a declined first card): the plan's consent and capacity (DEC-598,
    // DEC-601); a renewal paid in the grace is the auto-renewing V4 path, unchanged
    const plan = await policyOf(tx, sub);
    let consent: (ReturnType<typeof assertPurchaseConsent> & { planId: string }) | null = null;
    if (sub.status === 'pending_payment') {
      const c = assertPurchaseConsent(this.env, plan, body.purchase_consent);
      consent = c ? { ...c, planId: sub.plan_id } : null;
      await assertCapacity(tx, { id: sub.plan_id, venue_id: sub.venue_id, capacity: plan.capacity }, sub.id);
    }
    const source = await sourceOf(tx, accountId, body.source, body.save_card, plan.renewal_mode === 'manual');
    const amount = sub.next_price_halalas ?? sub.price_halalas;
    await this.beginPayment(tx, accountId, sub, {
      ...w,
      source,
      amount,
      seq,
      saveCard: body.save_card,
      consent,
    });
    return { source, amount, subscriptionId };
  }

  /** The `initiated` payment of the period, the consent and the card kept for the renewals (pending until paid). */
  private async beginPayment(
    tx: Tx,
    accountId: string,
    sub: Pick<SubscriptionRow, 'id' | 'org_id' | 'venue_id'>,
    w: {
      givenId: string;
      paymentId: string;
      card: GatewayToken | null;
      requestId: string | null;
      source: Source;
      amount: number;
      seq: number;
      saveCard: boolean | undefined;
      consent?: (CustomerPurchaseConsent & { planId: string }) | null;
    },
  ): Promise<void> {
    await this.payments.begin(tx, {
      id: w.paymentId,
      givenId: w.givenId,
      accountId,
      purpose: 'subscription',
      subscriptionId: sub.id,
      subscriptionPeriodSeq: w.seq,
      orgId: sub.org_id,
      venueId: sub.venue_id,
      amountHalalas: w.amount,
      source: w.source,
      callbackUrl: this.env.CUSTOMER_PAY_CALLBACK_URL,
      requestId: w.requestId,
    });
    if (w.consent) {
      // DEC-601 (annex clauses 3, 5, 6): what was shown and accepted, with the payment it starts (append-only)
      const vat = vatOfInclusive(w.amount);
      await tx.query(
        `INSERT INTO subscription_purchase_consents (subscription_id, account_id, org_id, venue_id, plan_id, period_seq,
                                                     online_payment_id, terms_version, privacy_version, price_halalas,
                                                     net_halalas, vat_halalas, non_refundable, valuables_notice,
                                                     request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          sub.id,
          accountId,
          sub.org_id,
          sub.venue_id,
          w.consent.planId,
          w.seq,
          w.paymentId,
          w.consent.terms_version,
          w.consent.privacy_version,
          w.amount,
          w.amount - vat,
          vat,
          w.consent.non_refundable,
          w.consent.valuables_notice,
          w.requestId,
          tx.now,
        ],
      );
    }
    if (w.card && w.source.type === 'token' && w.saveCard) {
      await tx.query(
        `INSERT INTO customer_account_consents (account_id, kind, version, granted, request_id, created_at)
         VALUES ($1, 'card_on_file', $2, true, $3, $4)`,
        [accountId, this.env.CUSTOMER_CARD_ON_FILE_VERSION, w.requestId, tx.now],
      );
      const card = await tx.maybeOne<{ id: string }>(
        `INSERT INTO customer_payment_methods (account_id, gateway, gateway_token, brand, last4, expires_month,
                                               expires_year, is_default, pending_payment_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)
         ON CONFLICT (gateway, gateway_token) DO NOTHING RETURNING id`,
        [
          accountId,
          this.rt.gateway.name,
          w.source.token,
          brandOf(w.card.brand),
          w.card.last4,
          monthOf(w.card.month),
          yearOf(w.card.year),
          w.paymentId,
          tx.now,
        ],
      );
      if (card)
        await tx.query(`UPDATE subscriptions SET payment_method_id = $2 WHERE id = $1`, [sub.id, card.id]);
    }
  }

  /** The handler inside the command transaction: the plan's subscription and payment, or its error. */
  async finalize(
    tx: Tx,
    actor: CustomerActorContext,
    plan: CheckoutPlan | undefined,
    client: ClientInfo,
    action: 'customer.subscription.subscribe' | 'customer.subscription.pay',
  ): Promise<CustomerSubscriptionCheckout> {
    if (!plan) throw new AppError('SERVICE_UNAVAILABLE');
    if (plan.kind === 'error') throw plan.error;
    const p = await subscriptionPaymentRow(tx, plan.paymentId);
    const [subscription] = await customerSubscriptions(tx, this.env, actor.accountId, {
      id: plan.subscriptionId,
      now: tx.now,
    });
    if (!p || !subscription || p.account_id !== actor.accountId) throw new AppError('SERVICE_UNAVAILABLE');
    await customerAudit(tx, {
      actor: { type: 'customer', accountId: actor.accountId },
      action,
      entityType: 'subscription',
      entityId: plan.subscriptionId,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: { online_payment_id: p.id, status: p.status, amount_halalas: p.amount_halalas },
    });
    return { subscription, payment: subscriptionPaymentView(this.env, p, plan.transactionUrl) };
  }
}

const payment = (subscriptionId: string, paymentId: string, transactionUrl: string | null): CheckoutPlan => ({
  kind: 'payment',
  subscriptionId,
  paymentId,
  transactionUrl,
});

/** Whether a subscription's plan is renewed by hand (null: no such subscription). */
async function manualRenewalOf(q: Q, subscriptionId: string): Promise<boolean | null> {
  const r = await q.query<{ renewal_mode: string }>(
    `SELECT p.renewal_mode FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id AND p.org_id = s.org_id
      WHERE s.id = $1`,
    [subscriptionId],
  );
  return r.rows[0] ? r.rows[0].renewal_mode === 'manual' : null;
}

/**
 * The purchase consent of a plan whose terms differ from V4's (DEC-601; `purchaseConsentRequired`): the terms and
 * privacy versions in force, and the non-refund condition accepted when the plan is non-refundable. Returned to be
 * recorded with the payment; a plan that does not require it records it when the app sends it.
 */
export function assertPurchaseConsent(
  env: Env,
  plan: Pick<PlanPolicyRow, 'refund_policy' | 'renewal_mode' | 'eligibility'>,
  consent: CustomerPurchaseConsent | undefined,
): CustomerPurchaseConsent | null {
  const required = purchaseConsentRequired(plan);
  const current = env.CUSTOMER_SUBSCRIPTION_TERMS_VERSION;
  if (!consent) {
    if (required)
      throw new AppError('CUSTOMER_CONSENT_REQUIRED', {
        kind: 'subscription_terms',
        current_version: current,
      });
    return null;
  }
  if (consent.terms_version !== current || consent.privacy_version !== env.CUSTOMER_PRIVACY_VERSION)
    throw new AppError('CUSTOMER_CONSENT_VERSION_STALE', {
      kind: 'subscription_terms',
      current_version: current,
      privacy_version: env.CUSTOMER_PRIVACY_VERSION,
    });
  if (plan.refund_policy === 'non_refundable' && !consent.non_refundable)
    throw new AppError('CUSTOMER_CONSENT_REQUIRED', { kind: 'subscription_terms', current_version: current });
  return consent;
}

/**
 * The approved capacity (DEC-598; annex clause 3 «يوقف بيع اشتراكات جديدة عند بلوغ الطاقة المعتمدة»): the seats
 * held on the plan's family, counted under a transaction-scoped advisory lock of the venue's capacity — taken after
 * the account and subscription rows — so that two checkouts never both take the last seat.
 */
export async function assertCapacity(
  tx: Tx,
  plan: Pick<PlanRow, 'id' | 'venue_id' | 'capacity'>,
  except: string | null,
): Promise<void> {
  if (plan.capacity === null) return;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('subscription_capacity:' || $1::text, 0))`, [
    plan.venue_id,
  ]);
  const r = await tx.one<{ n: number; mine: number }>(
    `SELECT ${seatsTakenSql('$1::uuid')} AS n,
            (SELECT count(*)::int FROM subscriptions s3
              WHERE s3.id = $2::uuid AND s3.status IN ('pending_payment','active','past_due','frozen')) AS mine`,
    [plan.id, except],
  );
  if (r.n - r.mine >= plan.capacity)
    throw new AppError('SUBSCRIPTION_CAPACITY_REACHED', { plan_id: plan.id, capacity: plan.capacity });
}

/** The covered vehicles are the account's own, not removed (else RESOURCE_NOT_FOUND customer_vehicle). */
export async function assertOwnVehicles(tx: Tx, accountId: string, ids: readonly string[]): Promise<void> {
  if (ids.some((id) => !UUID.test(id)))
    throw new AppError('RESOURCE_NOT_FOUND', { resource: 'customer_vehicle' });
  const r = await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM customer_vehicles WHERE id = ANY($1) AND account_id = $2 AND removed_at IS NULL`,
    [ids, accountId],
  );
  if (r.n !== ids.length) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'customer_vehicle' });
}
