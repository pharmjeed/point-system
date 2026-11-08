import { VAT_RATE_BASIS_POINTS } from '@point/shared';
import {
  saudiPlateDisplay,
  type CustomerSubscription,
  type CustomerSubscriptionPayment,
} from '@point/shared/customer';
import type { Env } from '../../../core/config/env.js';
import { iso, SUBSCRIPTION_COLUMNS, type Q, type SubscriptionRow } from './rows.js';

interface ViewRow extends SubscriptionRow {
  venue_name_ar: string;
  venue_name_en: string | null;
  operator_name_ar: string;
  operator_name_en: string | null;
  plan_name_ar: string;
  plan_name_en: string | null;
}

const VIEW_SELECT = `SELECT ${SUBSCRIPTION_COLUMNS}, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en,
       o.name_ar AS operator_name_ar, o.name_en AS operator_name_en, p.name_ar AS plan_name_ar, p.name_en AS plan_name_en
  FROM subscriptions s
  JOIN venues v ON v.id = s.venue_id AND v.org_id = s.org_id
  JOIN organizations o ON o.id = s.org_id
  JOIN subscription_plans p ON p.id = s.plan_id AND p.org_id = s.org_id`;

interface PaymentRow {
  id: string;
  subscription_id: string;
  account_id: string;
  status: CustomerSubscriptionPayment['status'];
  amount_halalas: number;
  vat_halalas: number;
  refunded_halalas: number;
  card_brand: string | null;
  card_last4: string | null;
  failure_code: string | null;
  paid_at: Date | null;
  created_at: Date;
  venue_name_ar: string | null;
  venue_name_en: string | null;
  operator_name_ar: string | null;
  operator_name_en: string | null;
  saved_payment_method_id: string | null;
}

const PAYMENT_SELECT = `SELECT p.id, p.subscription_id, p.account_id, p.status, p.amount_halalas::float8 AS amount_halalas,
       p.vat_halalas::float8 AS vat_halalas, p.refunded_halalas::float8 AS refunded_halalas, p.card_brand, p.card_last4,
       p.failure_code, p.paid_at, p.created_at, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en, o.name_ar AS operator_name_ar,
       o.name_en AS operator_name_en,
       (SELECT m.id FROM customer_audit_log a
          JOIN customer_payment_methods m ON m.id = a.entity_id AND m.account_id = p.account_id
         WHERE a.account_id = p.account_id AND a.action = 'customer.payment_method.saved'
           AND a.metadata->>'online_payment_id' = p.id::text AND m.removed_at IS NULL
         LIMIT 1) AS saved_payment_method_id
  FROM online_payments p
  LEFT JOIN venues v ON v.id = p.venue_id AND v.org_id = p.org_id
  LEFT JOIN organizations o ON o.id = p.org_id`;

/** C-10 / C-14: a subscription payment as the app sees it, with the simplified-invoice data once paid (DEC-525). */
export function subscriptionPaymentView(
  env: Env,
  r: PaymentRow,
  transactionUrl: string | null = null,
): CustomerSubscriptionPayment {
  const paidAt = iso(r.paid_at);
  return {
    payment_id: r.id,
    subscription_id: r.subscription_id,
    status: r.status,
    amount_halalas: r.amount_halalas,
    vat_halalas: r.vat_halalas,
    currency: 'SAR',
    card_brand: r.card_brand,
    card_last4: r.card_last4,
    failure_code: r.failure_code,
    transaction_url: r.status === 'initiated' ? transactionUrl : null,
    callback_url: env.CUSTOMER_PAY_CALLBACK_URL,
    paid_at: paidAt,
    saved_payment_method_id: r.saved_payment_method_id,
    receipt:
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
            description: 'subscription',
            amount_halalas: r.amount_halalas,
            net_halalas: r.amount_halalas - r.vat_halalas,
            vat_halalas: r.vat_halalas,
            vat_rate_bp: VAT_RATE_BASIS_POINTS,
            refunded_halalas: r.refunded_halalas,
            currency: 'SAR',
            card_brand: r.card_brand,
            card_last4: r.card_last4,
          }
        : null,
  };
}

export async function subscriptionPaymentRow(q: Q, paymentId: string): Promise<PaymentRow | null> {
  const r = await q.query<PaymentRow>(`${PAYMENT_SELECT} WHERE p.id = $1 AND p.purpose = 'subscription'`, [
    paymentId,
  ]);
  return r.rows[0] ?? null;
}

/**
 * The account's subscriptions as C-06 / C-14 show them (newest first), or one of them. Everything the app may do is
 * computed here from the same rules the commands check (DEC-532): cancel (pending, active, frozen, past due), resume
 * (a cancel at period end still undone), pay (pending, past due), change the vehicles (once per period).
 */
export async function customerSubscriptions(
  q: Q,
  env: Env,
  accountId: string,
  opts: { id?: string; now: Date; liveOnly?: boolean },
): Promise<CustomerSubscription[]> {
  const rows = (
    await q.query<ViewRow>(
      `${VIEW_SELECT} WHERE s.account_id = $1 ${opts.id ? 'AND s.id = $2' : ''}
        ${opts.liveOnly ? `AND s.status IN ('pending_payment','active','past_due','frozen')` : ''}
        ORDER BY s.created_at DESC, s.id LIMIT 100`,
      opts.id ? [accountId, opts.id] : [accountId],
    )
  ).rows;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const vehicles = (
    await q.query<{
      subscription_id: string;
      vehicle_id: string;
      digits: string | null;
      letters_ar: string | null;
      removed: boolean;
    }>(
      `SELECT sv.subscription_id, cv.id AS vehicle_id, cv.plate_digits AS digits, cv.plate_letters_ar AS letters_ar,
              (cv.removed_at IS NOT NULL) AS removed
         FROM subscription_vehicles sv JOIN customer_vehicles cv ON cv.id = sv.customer_vehicle_id
        WHERE sv.subscription_id = ANY($1) AND sv.removed_at IS NULL AND sv.account_id = $2
        ORDER BY sv.added_at, cv.id`,
      [ids, accountId],
    )
  ).rows;
  const payments = (
    await q.query<PaymentRow>(
      `SELECT DISTINCT ON (x.subscription_id) x.* FROM (${PAYMENT_SELECT}
         WHERE p.subscription_id = ANY($1) AND p.account_id = $2 AND p.purpose = 'subscription') x
        ORDER BY x.subscription_id, x.created_at DESC, x.id DESC`,
      [ids, accountId],
    )
  ).rows;
  return rows.map((s) => {
    const latest = payments.find((p) => p.subscription_id === s.id) ?? null;
    const live = ['pending_payment', 'active', 'past_due', 'frozen'].includes(s.status);
    const changeOpen =
      ['active', 'past_due', 'frozen'].includes(s.status) &&
      (!s.vehicles_changed_at ||
        !s.current_period_start ||
        s.vehicles_changed_at.getTime() < s.current_period_start.getTime());
    return {
      subscription_id: s.id,
      venue_id: s.venue_id,
      venue_name_ar: s.venue_name_ar,
      venue_name_en: s.venue_name_en,
      operator_name_ar: s.operator_name_ar,
      operator_name_en: s.operator_name_en,
      plan_id: s.plan_id,
      plan_name_ar: s.plan_name_ar,
      plan_name_en: s.plan_name_en,
      billing_cycle: s.billing_cycle,
      status: s.status,
      price_halalas: s.price_halalas,
      next_price_halalas: s.next_price_halalas,
      vehicles_included: s.vehicles_included,
      vehicles: vehicles
        .filter((v) => v.subscription_id === s.id)
        .map((v) => ({
          vehicle_id: v.vehicle_id,
          plate_display: v.digits || v.letters_ar ? saudiPlateDisplay(v) : null,
          removed: v.removed,
        })),
      current_period_start: iso(s.current_period_start),
      current_period_end: iso(s.current_period_end),
      cancel_at_period_end: s.cancel_at_period_end,
      renews_at: s.status === 'active' && !s.cancel_at_period_end ? iso(s.current_period_end) : null,
      pending_expires_at: iso(s.pending_expires_at),
      grace_ends_at: iso(s.grace_ends_at),
      frozen_at: iso(s.frozen_at),
      frozen_reason: s.frozen_reason,
      can_change_vehicles: changeOpen,
      can_cancel: live && !s.cancel_at_period_end,
      can_resume: (s.status === 'active' || s.status === 'frozen') && s.cancel_at_period_end,
      can_pay: s.status === 'pending_payment' || s.status === 'past_due',
      latest_payment: latest ? subscriptionPaymentView(env, latest) : null,
      ended_at: iso(s.ended_at),
      ended_reason: s.ended_reason,
      created_at: iso(s.created_at)!,
    };
  });
}
