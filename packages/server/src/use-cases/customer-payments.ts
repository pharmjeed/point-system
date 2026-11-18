import {
  VAT_RATE_BASIS_POINTS,
  type OnlinePaymentStatus,
  type TicketEntitlement,
  type TicketStatus,
} from '@point/shared';
import {
  CustomerPaymentMethodCreateBodySchema,
  CustomerVisitPayBodySchema,
  type CustomerPaymentMethod,
  type CustomerPaymentMethodCreateBody,
  type CustomerPaymentMethodRemoved,
  type CustomerVisitPayBody,
  type CustomerOnlinePayment,
} from '@point/shared/customer';
import type { CustomerActorContext } from '../core/actor-context/customer-actor.js';
import { customerAudit } from '../core/audit/customer-audit.js';
import type { Env } from '../core/config/env.js';
import { sha256Hex } from '../core/crypto/crypto.js';
import { newId } from '../core/crypto/ids.js';
import type { Database } from '../core/db/database.js';
import { lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import type { ClientInfo } from '../modules/identity-access/application/auth-service.js';
import { lockCustomerAccount } from '../modules/customer-accounts/index.js';
import { alreadyRecorded } from '../modules/payments-reports/index.js';
import {
  OnlinePayments,
  queueTokenDeletion,
  retryableFailure,
  type GatewaySource,
  type GatewayToken,
  type PaymentsRuntime,
} from '../modules/payments-online/index.js';
// the ticket effects of a visit payment are registered when the use-cases load
import './visit-payments.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The gateway's minimum (1.00 SAR, ck_online_payments_amount). */
const MIN_ONLINE_HALALAS = 100;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/**
 * The gateway's idempotency key of a pay command (DEC-521): derived from the account and the command's
 * Idempotency-Key, so concurrent or retried requests with one key can only ever create one payment
 * (`uq_online_payments_given_id` here, `given_id` at the gateway), whatever reaches the gateway first.
 */
export function visitPayGivenId(accountId: string, idempotencyKey: string): string {
  const h = sha256Hex(`point-visit-pay:v1:${accountId}:${idempotencyKey}`);
  // an RFC 4122 v4-shaped uuid (version and variant bits set) made of the digest
  const v = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ------------------------------------------------------------------------------------------------
// reads
// ------------------------------------------------------------------------------------------------

interface VisitTicket {
  id: string;
  org_id: string;
  venue_id: string;
  status: TicketStatus;
  payment_status: 'not_required' | 'due' | 'collected' | 'waived';
  fee_halalas: number;
  entitlement: TicketEntitlement;
}

/** The account's ticket (DEC-504's link: the operator's customers row carries the account), else null. */
async function accountTicket(q: Q, accountId: string, ticketId: string) {
  const r = await q.query<VisitTicket>(
    `SELECT t.id, t.org_id, t.venue_id, t.status, t.payment_status, t.fee_halalas::float8 AS fee_halalas,
            t.entitlement
       FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
      WHERE t.id = $1 AND c.customer_account_id = $2`,
    [ticketId, accountId],
  );
  return r.rows[0] ?? null;
}

interface PaymentViewRow {
  id: string;
  account_id: string;
  ticket_id: string | null;
  status: OnlinePaymentStatus;
  amount_halalas: number;
  vat_halalas: number;
  refunded_halalas: number;
  card_brand: string | null;
  card_last4: string | null;
  failure_code: string | null;
  paid_at: Date | null;
  venue_name_ar: string | null;
  venue_name_en: string | null;
  operator_name_ar: string | null;
  operator_name_en: string | null;
  saved_payment_method_id: string | null;
}

async function paymentViewRow(q: Q, paymentId: string): Promise<PaymentViewRow | null> {
  const r = await q.query<PaymentViewRow>(
    `SELECT p.id, p.account_id, p.ticket_id, p.status, p.amount_halalas::float8 AS amount_halalas,
            p.vat_halalas::float8 AS vat_halalas, p.refunded_halalas::float8 AS refunded_halalas, p.card_brand,
            p.card_last4, p.failure_code, p.paid_at, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en,
            o.name_ar AS operator_name_ar, o.name_en AS operator_name_en,
            -- the card this payment saved (confirmed by it: customer.payment_method.saved names the payment)
            (SELECT m.id FROM customer_audit_log a
               JOIN customer_payment_methods m ON m.id = a.entity_id AND m.account_id = p.account_id
              WHERE a.account_id = p.account_id AND a.action = 'customer.payment_method.saved'
                AND a.metadata->>'online_payment_id' = p.id::text AND m.removed_at IS NULL
              LIMIT 1) AS saved_payment_method_id
       FROM online_payments p
       LEFT JOIN venues v ON v.id = p.venue_id AND v.org_id = p.org_id
       LEFT JOIN organizations o ON o.id = p.org_id
      WHERE p.id = $1 AND p.purpose = 'visit'`,
    [paymentId],
  );
  return r.rows[0] ?? null;
}

/** C-12 / C-17: a visit payment as the app sees it, with the simplified-invoice data once it is paid (DEC-525). */
function paymentView(
  env: Env,
  r: PaymentViewRow,
  extra: { transactionUrl?: string | null } = {},
): CustomerOnlinePayment {
  const paidAt = iso(r.paid_at);
  const receipt =
    paidAt && r.venue_name_ar && r.operator_name_ar
      ? {
          payment_id: r.id,
          issued_at: paidAt,
          seller_name_ar: env.BRAND_CUSTOMER_NAME_AR,
          seller_name_en: env.BRAND_CUSTOMER_NAME_EN,
          venue_name_ar: r.venue_name_ar,
          venue_name_en: r.venue_name_en,
          operator_name_ar: r.operator_name_ar,
          operator_name_en: r.operator_name_en,
          description: 'visit' as const,
          amount_halalas: r.amount_halalas,
          net_halalas: r.amount_halalas - r.vat_halalas,
          vat_halalas: r.vat_halalas,
          vat_rate_bp: VAT_RATE_BASIS_POINTS,
          refunded_halalas: r.refunded_halalas,
          currency: 'SAR' as const,
          card_brand: r.card_brand,
          card_last4: r.card_last4,
        }
      : null;
  return {
    payment_id: r.id,
    ticket_id: r.ticket_id!,
    status: r.status,
    amount_halalas: r.amount_halalas,
    vat_halalas: r.vat_halalas,
    currency: 'SAR',
    card_brand: r.card_brand,
    card_last4: r.card_last4,
    failure_code: r.failure_code,
    transaction_url: r.status === 'initiated' ? (extra.transactionUrl ?? null) : null,
    callback_url: env.CUSTOMER_PAY_CALLBACK_URL,
    paid_at: paidAt,
    saved_payment_method_id: r.saved_payment_method_id,
    receipt,
  };
}

/** `GET /v1/customer/payments/{paymentId}`: the account's own visit payment (polled after 3-D Secure). */
export async function getCustomerPayment(
  db: Database,
  env: Env,
  accountId: string,
  paymentId: string,
): Promise<CustomerOnlinePayment> {
  const r = UUID.test(paymentId) ? await paymentViewRow(db, paymentId) : null;
  if (!r || r.account_id !== accountId)
    throw new AppError('RESOURCE_NOT_FOUND', { resource: 'online_payment' });
  return paymentView(env, r);
}

// ------------------------------------------------------------------------------------------------
// consent «حفظ البطاقة» (card_on_file)
// ------------------------------------------------------------------------------------------------

/** The explicit consent a saved card needs (DEC-524): the version in force, else nothing is saved. */
function assertCardConsent(env: Env, version: string | undefined): void {
  const current = env.CUSTOMER_CARD_ON_FILE_VERSION;
  if (!version)
    throw new AppError('CUSTOMER_CONSENT_REQUIRED', { kind: 'card_on_file', current_version: current });
  if (version !== current)
    throw new AppError('CUSTOMER_CONSENT_VERSION_STALE', { kind: 'card_on_file', current_version: current });
}

async function recordCardConsent(tx: Tx, env: Env, accountId: string, requestId: string | null) {
  await tx.query(
    `INSERT INTO customer_account_consents (account_id, kind, version, granted, request_id, created_at)
     VALUES ($1, 'card_on_file', $2, true, $3, $4)`,
    [accountId, env.CUSTOMER_CARD_ON_FILE_VERSION, requestId, tx.now],
  );
}

/** Reads a device-tokenized card at the gateway (network: before any transaction). */
async function readToken(rt: PaymentsRuntime, token: string): Promise<GatewayToken> {
  const r = await rt.gateway.fetchToken(token);
  if (!r.ok) {
    if (r.kind === 'http' && (r.status === 404 || r.status === 400))
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'token', issue: 'unknown_token' }] });
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

// ------------------------------------------------------------------------------------------------
// POST /v1/customer/visits/{ticketId}/pay (V2-022, DEC-521)
// ------------------------------------------------------------------------------------------------

/** What the network phase of the pay command left for the command transaction (DEC-96 pattern). */
export type VisitPayPlan =
  { kind: 'payment'; paymentId: string; transactionUrl: string | null } | { kind: 'error'; error: AppError };

/**
 * `POST /v1/customer/visits/{ticketId}/pay` (C-12 → C-10; V2-022, DEC-521). Network then commit (DEC-96): the route
 * guard runs `prepare` before the command transaction opens, and the handler answers its plan inside it, so the
 * Idempotency-Key protocol is unchanged (a deterministic 4xx — PAYMENT_FAILED included — is stored with the key, a
 * 5xx is not and the retry resumes the same payment). `prepare`:
 *
 * 1. a payment of this key already exists (the given_id is derived from the key): one that never reached the
 *    gateway is sent again with its given_id (the gateway never charges twice), otherwise it is answered as it is;
 * 2. a saved card for later (`save_card`): its consent at the version in force, then its token read at the gateway;
 * 3. one transaction, the ticket locked (L5): the account's ticket (else RESOURCE_NOT_FOUND), not delivered or voided,
 *    nothing paid yet (online or cash/POS → PAYMENT_ALREADY_RECORDED), an entitlement of `none` and a fee still due
 *    of at least 1.00 SAR (else VISIT_NOT_PAYABLE), no earlier payment of the visit still waiting for 3-D Secure
 *    (PAYMENT_IN_PROGRESS); the amount is the ticket's fee — VAT included — exactly what the driver would collect
 *    (13 §4); the `initiated` row, the consent and the pending card are written;
 * 4. the gateway call and its answer (OnlinePayments): `paid` at once, `failed` (PAYMENT_FAILED), or `initiated`
 *    with the 3-D Secure page for the app. The ticket is collected by the payment's own move (visit-payments.ts).
 */
export class VisitPayUseCase {
  private readonly payments: OnlinePayments;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly rt: PaymentsRuntime,
  ) {
    this.payments = new OnlinePayments(db, rt);
  }

  async prepare(
    accountId: string,
    ticketId: string,
    raw: unknown,
    idempotencyKey: string,
    requestId: string | null,
  ): Promise<VisitPayPlan | undefined> {
    const parsed = CustomerVisitPayBodySchema.safeParse(raw ?? {});
    if (!parsed.success) return undefined; // the body pipe answers VALIDATION_FAILED
    const body = parsed.data;
    try {
      if (!UUID.test(ticketId)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'visit' });
      const givenId = visitPayGivenId(accountId, idempotencyKey);
      const existing = await this.db.query<{
        id: string;
        status: OnlinePaymentStatus;
        gateway_payment_id: string | null;
        amount_halalas: number;
        payment_method_id: string | null;
      }>(
        `SELECT id, status, gateway_payment_id, amount_halalas::float8 AS amount_halalas, payment_method_id
           FROM online_payments WHERE given_id = $1 AND account_id = $2`,
        [givenId, accountId],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.status === 'initiated' && !prior.gateway_payment_id) {
          const source = await this.gatewaySource(this.db, accountId, body);
          const sent = await this.payments.sendInitiated(prior.id, {
            source,
            callbackUrl: this.env.CUSTOMER_PAY_CALLBACK_URL,
            amountHalalas: prior.amount_halalas,
            purpose: 'visit',
            ticketId,
          });
          return { kind: 'payment', paymentId: prior.id, transactionUrl: sent.actionUrl };
        }
        return { kind: 'payment', paymentId: prior.id, transactionUrl: null };
      }
      let card: GatewayToken | null = null;
      if (body.save_card && body.source.type === 'token') {
        assertCardConsent(this.env, body.card_on_file_version);
        card = await readToken(this.rt, body.source.token);
      }
      const id = newId();
      const { amount, source, twin } = await this.db.transaction(async (tx) => {
        // the account's ticket, then its lock (L5, canon §14ب) and the same read under it (TOCTOU, 09 §8.4)
        if (!(await accountTicket(tx, accountId, ticketId)))
          throw new AppError('RESOURCE_NOT_FOUND', { resource: 'visit' });
        await lockTickets(tx, [ticketId]);
        const t = await accountTicket(tx, accountId, ticketId);
        if (!t) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'visit' });
        // a concurrent request with the same key wrote the payment while this one waited for the lock
        const twin = await tx.maybeOne<{ id: string }>(`SELECT id FROM online_payments WHERE given_id = $1`, [
          givenId,
        ]);
        if (twin) return { amount: t.fee_halalas, source: null, twin: twin.id };
        if (t.status === 'voided') throw new AppError('VISIT_NOT_PAYABLE', { reason: 'voided' });
        if (t.status === 'delivered') throw new AppError('VISIT_NOT_PAYABLE', { reason: 'delivered' });
        if (t.entitlement === 'app_paid' || t.payment_status === 'collected')
          throw await alreadyRecorded(tx, t.id);
        if (t.entitlement !== 'none') throw new AppError('VISIT_NOT_PAYABLE', { reason: 'entitlement' });
        if (t.payment_status !== 'due') throw new AppError('VISIT_NOT_PAYABLE', { reason: 'not_due' });
        if (t.fee_halalas < MIN_ONLINE_HALALAS)
          throw new AppError('VISIT_NOT_PAYABLE', { reason: 'below_minimum' });
        const live = await tx.maybeOne<{ id: string; created_at: Date }>(
          `SELECT id, created_at FROM online_payments
            WHERE ticket_id = $1 AND purpose = 'visit' AND status IN ('initiated','authorized') AND created_at > $2
            ORDER BY created_at DESC LIMIT 1`,
          [t.id, new Date(tx.now.getTime() - this.env.VISIT_PAYMENT_PENDING_S * 1000)],
        );
        if (live)
          throw new AppError('PAYMENT_IN_PROGRESS', {
            online_payment_id: live.id,
            retry_after_s: Math.max(
              1,
              Math.ceil(
                (new Date(live.created_at).getTime() +
                  this.env.VISIT_PAYMENT_PENDING_S * 1000 -
                  tx.now.getTime()) /
                  1000,
              ),
            ),
          });
        const src = await this.gatewaySource(tx, accountId, body);
        await this.payments.begin(tx, {
          id,
          givenId,
          accountId,
          purpose: 'visit',
          ticketId: t.id,
          orgId: t.org_id,
          venueId: t.venue_id,
          amountHalalas: t.fee_halalas,
          source: src,
          callbackUrl: this.env.CUSTOMER_PAY_CALLBACK_URL,
          requestId,
        });
        if (card && body.source.type === 'token') {
          await recordCardConsent(tx, this.env, accountId, requestId);
          await tx.query(
            `INSERT INTO customer_payment_methods (account_id, gateway, gateway_token, brand, last4, expires_month,
                                                   expires_year, is_default, pending_payment_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)
             ON CONFLICT (gateway, gateway_token) DO NOTHING`,
            [
              accountId,
              this.rt.gateway.name,
              body.source.token,
              brandOf(card.brand),
              card.last4,
              monthOf(card.month),
              yearOf(card.year),
              id,
              tx.now,
            ],
          );
        }
        return { amount: t.fee_halalas, source: src, twin: null };
      });
      if (twin || !source) return { kind: 'payment', paymentId: twin ?? id, transactionUrl: null };
      const sent = await this.payments.sendInitiated(id, {
        source,
        callbackUrl: this.env.CUSTOMER_PAY_CALLBACK_URL,
        amountHalalas: amount,
        purpose: 'visit',
        ticketId,
      });
      return { kind: 'payment', paymentId: id, transactionUrl: sent.actionUrl };
    } catch (e) {
      if (e instanceof AppError) return { kind: 'error', error: e };
      throw e;
    }
  }

  /** The gateway source of the body: a saved card resolves to the account's own token (C-18). */
  private async gatewaySource(
    q: Q,
    accountId: string,
    body: CustomerVisitPayBody,
  ): Promise<GatewaySource | { type: 'saved'; paymentMethodId: string; token: string }> {
    if (body.source.type !== 'saved') return body.source;
    const r = await q.query<{ id: string; gateway_token: string }>(
      `SELECT id, gateway_token FROM customer_payment_methods
        WHERE id = $1 AND account_id = $2 AND removed_at IS NULL AND pending_payment_id IS NULL`,
      [body.source.payment_method_id, accountId],
    );
    const m = r.rows[0];
    if (!m) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'payment_method' });
    return { type: 'saved', paymentMethodId: m.id, token: m.gateway_token };
  }

  /**
   * The handler, inside the command transaction: the plan's payment as it stands (with the command's own audit row,
   * `customer.visit.pay`), or its error.
   */
  async finalize(
    tx: Tx,
    actor: CustomerActorContext,
    plan: VisitPayPlan | undefined,
    client: ClientInfo,
  ): Promise<CustomerOnlinePayment> {
    if (!plan) throw new AppError('SERVICE_UNAVAILABLE');
    if (plan.kind === 'error') throw plan.error;
    const r = await paymentViewRow(tx, plan.paymentId);
    if (!r || r.account_id !== actor.accountId) throw new AppError('SERVICE_UNAVAILABLE');
    await customerAudit(tx, {
      actor: { type: 'customer', accountId: actor.accountId },
      action: 'customer.visit.pay',
      entityType: 'online_payment',
      entityId: r.id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: { ticket_id: r.ticket_id, status: r.status, amount_halalas: r.amount_halalas },
    });
    return paymentView(this.env, r, { transactionUrl: plan.transactionUrl });
  }
}

// ------------------------------------------------------------------------------------------------
// C-18 saved cards (V2-023, DEC-524)
// ------------------------------------------------------------------------------------------------

interface MethodRow {
  id: string;
  brand: string | null;
  last4: string | null;
  expires_month: number | null;
  expires_year: number | null;
  is_default: boolean;
  created_at: Date;
}

const METHOD_COLUMNS = `id, brand, last4, expires_month, expires_year, is_default, created_at`;

function methodView(m: MethodRow): CustomerPaymentMethod {
  return {
    id: m.id,
    brand: m.brand,
    last4: m.last4,
    expires_month: m.expires_month,
    expires_year: m.expires_year,
    is_default: m.is_default,
    created_at: iso(m.created_at)!,
  };
}

/** `GET /v1/customer/payment-methods`: the cards on file (not removed, not pending), the default first. */
export async function listPaymentMethods(q: Q, accountId: string) {
  const r = await q.query<MethodRow>(
    `SELECT ${METHOD_COLUMNS} FROM customer_payment_methods
      WHERE account_id = $1 AND removed_at IS NULL AND pending_payment_id IS NULL
      ORDER BY is_default DESC, created_at DESC, id`,
    [accountId],
  );
  return { items: r.rows.map(methodView) };
}

async function ownMethod(tx: Tx, accountId: string, id: string): Promise<MethodRow> {
  const r = UUID.test(id)
    ? await tx.maybeOne<MethodRow>(
        `SELECT ${METHOD_COLUMNS} FROM customer_payment_methods
          WHERE id = $1 AND account_id = $2 AND removed_at IS NULL AND pending_payment_id IS NULL`,
        [id, accountId],
      )
    : null;
  if (!r) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'payment_method' });
  return r;
}

export type PaymentMethodPlan = { kind: 'token'; token: GatewayToken } | { kind: 'error'; error: AppError };

/**
 * C-18 (V2-023, DEC-524). Saving a card: the device tokenizes it with the publishable key (Moyasar `save_only`); the
 * route guard reads the token at the gateway before the command transaction (DEC-96), so brand, last four and expiry
 * are the gateway's, never the app's; the command records the `card_on_file` consent at the version in force and
 * the card (the default one when it is the first, or when asked). Setting the default and removing a card are
 * transactional under the account row's lock; a removed card's token is deleted at the gateway after COMMIT.
 */
export class PaymentMethodsUseCase {
  constructor(
    private readonly env: Env,
    private readonly rt: PaymentsRuntime,
  ) {}

  async prepareCreate(raw: unknown): Promise<PaymentMethodPlan | undefined> {
    const parsed = CustomerPaymentMethodCreateBodySchema.safeParse(raw ?? {});
    if (!parsed.success) return undefined;
    try {
      assertCardConsent(this.env, parsed.data.card_on_file_version);
      return { kind: 'token', token: await readToken(this.rt, parsed.data.token) };
    } catch (e) {
      if (e instanceof AppError) return { kind: 'error', error: e };
      throw e;
    }
  }

  async create(
    tx: Tx,
    actor: CustomerActorContext,
    body: CustomerPaymentMethodCreateBody,
    plan: PaymentMethodPlan | undefined,
    client: ClientInfo,
  ): Promise<CustomerPaymentMethod> {
    if (!plan) throw new AppError('SERVICE_UNAVAILABLE');
    if (plan.kind === 'error') throw plan.error;
    assertCardConsent(this.env, body.card_on_file_version);
    await lockCustomerAccount(tx, actor.accountId);
    const known = await tx.maybeOne<MethodRow & { account_id: string; removed_at: Date | null }>(
      `SELECT ${METHOD_COLUMNS}, account_id, removed_at FROM customer_payment_methods
        WHERE gateway = $1 AND gateway_token = $2`,
      [this.rt.gateway.name, body.token],
    );
    if (known) {
      // the same card on file already (a retried save with another key): answered as it is
      if (known.account_id === actor.accountId && !known.removed_at) return methodView(known);
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'token', issue: 'already_used' }] });
    }
    await recordCardConsent(tx, this.env, actor.accountId, client.requestId);
    const hasDefault = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM customer_payment_methods WHERE account_id = $1 AND is_default AND removed_at IS NULL`,
      [actor.accountId],
    );
    const makeDefault = !hasDefault || body.make_default === true;
    if (makeDefault && hasDefault)
      await tx.query(`UPDATE customer_payment_methods SET is_default = false WHERE id = $1`, [hasDefault.id]);
    const t = plan.token;
    const row = await tx.one<MethodRow>(
      `INSERT INTO customer_payment_methods (id, account_id, gateway, gateway_token, brand, last4, expires_month,
                                             expires_year, is_default, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${METHOD_COLUMNS}`,
      [
        newId(),
        actor.accountId,
        this.rt.gateway.name,
        body.token,
        brandOf(t.brand),
        t.last4,
        monthOf(t.month),
        yearOf(t.year),
        makeDefault,
        tx.now,
      ],
    );
    await customerAudit(tx, {
      actor: { type: 'customer', accountId: actor.accountId },
      action: 'customer.payment_method.saved',
      entityType: 'customer_payment_method',
      entityId: row.id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: { via: 'c18', brand: row.brand, is_default: row.is_default },
    });
    return methodView(row);
  }

  async setDefault(
    tx: Tx,
    actor: CustomerActorContext,
    id: string,
    client: ClientInfo,
  ): Promise<CustomerPaymentMethod> {
    await lockCustomerAccount(tx, actor.accountId);
    const m = await ownMethod(tx, actor.accountId, id);
    if (!m.is_default) {
      await tx.query(
        `UPDATE customer_payment_methods SET is_default = false
          WHERE account_id = $1 AND is_default AND removed_at IS NULL`,
        [actor.accountId],
      );
      await tx.query(`UPDATE customer_payment_methods SET is_default = true WHERE id = $1`, [m.id]);
    }
    await customerAudit(tx, {
      actor: { type: 'customer', accountId: actor.accountId },
      action: 'customer.payment_method.default',
      entityType: 'customer_payment_method',
      entityId: m.id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: { noop: m.is_default },
    });
    return methodView({ ...m, is_default: true });
  }

  async remove(
    tx: Tx,
    actor: CustomerActorContext,
    id: string,
    client: ClientInfo,
  ): Promise<CustomerPaymentMethodRemoved> {
    await lockCustomerAccount(tx, actor.accountId);
    const m = await ownMethod(tx, actor.accountId, id);
    await tx.query(`UPDATE customer_payment_methods SET removed_at = $2, is_default = false WHERE id = $1`, [
      m.id,
      tx.now,
    ]);
    // the newest remaining card becomes the default when the default one leaves
    if (m.is_default)
      await tx.query(
        `UPDATE customer_payment_methods SET is_default = true
          WHERE id = (SELECT id FROM customer_payment_methods
                       WHERE account_id = $1 AND removed_at IS NULL AND pending_payment_id IS NULL
                       ORDER BY created_at DESC, id LIMIT 1)`,
        [actor.accountId],
      );
    await queueTokenDeletion(tx, [m.id]);
    await customerAudit(tx, {
      actor: { type: 'customer', accountId: actor.accountId },
      action: 'customer.payment_method.removed',
      entityType: 'customer_payment_method',
      entityId: m.id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: { was_default: m.is_default },
    });
    return { payment_method_id: m.id, removed_at: tx.now.toISOString() };
  }
}
