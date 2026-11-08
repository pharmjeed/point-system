/**
 * V2-024 — the platform console's P-06 «العملاء» and P-08 «المدفوعات والاسترداد» (docs/v2/02 §2, docs/v2/04 §3;
 * DEC-526 … DEC-530): the query and body shapes of their `/v1/platform/*` routes, shared by the server (validation)
 * and the web console (the same names and limits). The routes themselves are rows of `PLATFORM_ROUTES`.
 */
import { z } from 'zod';
import {
  OnlinePaymentPurposeSchema,
  OnlinePaymentStatusSchema,
  PlatformAlertTypeSchema,
} from './canon/payments-online.js';

/** `customer_accounts.status` (`ck_customer_accounts_status`, 0009). */
export const PLATFORM_CUSTOMER_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type PlatformCustomerStatus = (typeof PLATFORM_CUSTOMER_STATUSES)[number];

/**
 * The account commands of P-06 (`platform.customer_manage`, DEC-527): `from` → `to`. `revoke_sessions` keeps the
 * status and ends every live session of the account. A deleted account (C-20) is final: no command applies to it.
 */
export const CUSTOMER_ACCOUNT_TRANSITIONS = {
  suspend: { from: ['active'], to: 'suspended' },
  reactivate: { from: ['suspended'], to: 'active' },
  revoke_sessions: { from: ['active', 'suspended'], to: null },
} as const satisfies Record<
  string,
  { from: readonly PlatformCustomerStatus[]; to: PlatformCustomerStatus | null }
>;
export type CustomerAccountCommand = keyof typeof CUSTOMER_ACCOUNT_TRANSITIONS;

/** `customer_account_sessions.revoked_reason` written when the platform ends an account's sessions (0015). */
export const PLATFORM_REVOKED_SESSION_REASON = 'platform_revoked';

/** The reason or note of a platform command: 3 characters at least once trimmed (REASON_REQUIRED), 500 at most. */
export const PLATFORM_REASON_MIN = 3;
export const PLATFORM_REASON_MAX = 500;

const isoDate = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');
const cursor = z.string().min(1).max(512).optional();
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);

/**
 * `GET /v1/platform/customers`: with `phone` an exact search (any Saudi format, normalized like the sign-in,
 * `normalizeSaudiMobile`; not a Saudi mobile → PHONE_INVALID), without it the newest accounts. Never a partial
 * phone search: the list is not a way to enumerate numbers.
 */
export const PlatformCustomersQuerySchema = z.strictObject({
  phone: z.string().trim().min(1).max(32).optional(),
  status: z.enum(PLATFORM_CUSTOMER_STATUSES).optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformCustomersQuery = z.infer<typeof PlatformCustomersQuerySchema>;

/** suspend / reactivate / sessions/revoke: a recorded reason (REASON_REQUIRED before the shape). */
export const PlatformCustomerReasonBodySchema = z.strictObject({
  reason: z.string().max(PLATFORM_REASON_MAX).nullish(),
});
export type PlatformCustomerReasonBody = z.infer<typeof PlatformCustomerReasonBodySchema>;

/**
 * `GET /v1/platform/payments`: `from`/`to` are days of Asia/Riyadh (inclusive, `from` ≤ `to`),
 * applied to `created_at`.
 */
export const PlatformPaymentsQuerySchema = z.strictObject({
  status: OnlinePaymentStatusSchema.optional(),
  purpose: OnlinePaymentPurposeSchema.optional(),
  org_id: z.uuid().optional(),
  venue_id: z.uuid().optional(),
  account_id: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformPaymentsQuery = z.infer<typeof PlatformPaymentsQuerySchema>;

/** `GET /v1/platform/reconciliation-runs`: `from`/`to` on `run_date` (the Riyadh day compared). */
export const PlatformReconciliationRunsQuerySchema = z.strictObject({
  status: z.enum(['running', 'matched', 'mismatched', 'failed']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor,
  limit: limit(100, 30),
});
export type PlatformReconciliationRunsQuery = z.infer<typeof PlatformReconciliationRunsQuerySchema>;

/** `GET /v1/platform/alerts`: `open` = not resolved (open or acknowledged), the default. */
export const PlatformAlertsQuerySchema = z.strictObject({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  type: PlatformAlertTypeSchema.optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformAlertsQuery = z.infer<typeof PlatformAlertsQuerySchema>;

/** `POST /v1/platform/alerts/{alertId}/resolve`: the resolution note (REASON_REQUIRED on `note`). */
export const PlatformAlertResolveBodySchema = z.strictObject({
  note: z.string().max(PLATFORM_REASON_MAX).nullish(),
});
export type PlatformAlertResolveBody = z.infer<typeof PlatformAlertResolveBodySchema>;
