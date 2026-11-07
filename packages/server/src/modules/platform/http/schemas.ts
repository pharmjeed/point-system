import { z } from 'zod';

export const PlatformLoginBody = z.strictObject({
  phone: z.string().min(1).max(32),
  secret: z.string().min(6).max(128),
});
export const PlatformMfaVerifyBody = z.strictObject({
  mfa_token: z.string().min(16).max(256),
  code: z.string().regex(/^[0-9]{6}$/),
});
export const PlatformMfaConfirmBody = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });
export const PlatformSecretChangeBody = z.strictObject({
  current_secret: z.string().min(1).max(128),
  new_secret: z.string().min(6).max(128),
});

export type PlatformLoginBody = z.infer<typeof PlatformLoginBody>;
export type PlatformMfaVerifyBody = z.infer<typeof PlatformMfaVerifyBody>;
export type PlatformMfaConfirmBody = z.infer<typeof PlatformMfaConfirmBody>;
export type PlatformSecretChangeBody = z.infer<typeof PlatformSecretChangeBody>;

// ---------------------------------------------------------------------------------------------- V2-003 / V2-005

const isoDate = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const halalas = z.number().int().min(0).max(100_000_000_000);

/** `POST /v1/platform/operators` (P-02 «إضافة مشغل»). */
export const CreateOperatorBody = z.strictObject({
  name_ar: text(2, 120),
  name_en: text(1, 120).nullish(),
  legal_name: text(2, 200),
  cr_number: z
    .string()
    .regex(/^[0-9]{10}$/)
    .nullish(),
  vat_number: z
    .string()
    .regex(/^3[0-9]{13}3$/)
    .nullish(),
  operator_status: z.enum(['trial', 'active']),
  is_platform_operated: z.boolean().optional(),
  owner: z.strictObject({
    full_name: text(2, 80),
    phone: z.string().min(1).max(32),
  }),
});

/** `POST /v1/platform/operators/{orgId}/contracts`. */
export const CreateContractBody = z
  .strictObject({
    saas_fee_halalas_per_venue: halalas,
    saas_cycle: z.enum(['monthly', 'yearly']),
    subscriber_visit_payout_halalas: halalas,
    app_payment_commission_bp: z.number().int().min(0).max(10_000),
    starts_on: isoDate,
    ends_on: isoDate.nullish(),
  })
  .refine((b) => !b.ends_on || b.ends_on > b.starts_on, {
    path: ['ends_on'],
    message: 'not_after_start',
  });

/** `POST /v1/platform/operators/{orgId}/contracts/{contractId}/end`. */
export const EndContractBody = z.strictObject({
  ends_on: isoDate,
  reason: z.string().max(500).nullish(),
});

/** suspend / terminate (a reason of 3+ characters, REASON_REQUIRED) and activate / reactivate (an optional note). */
export const OperatorReasonBody = z.strictObject({ reason: z.string().max(500).nullish() });
export const OptionalReasonBody = OperatorReasonBody;
export const EmptyBody = z.strictObject({});

export const OperatorsQuery = z.strictObject({
  status: z.enum(['invited', 'trial', 'active', 'suspended', 'terminated']).optional(),
});

export type CreateOperatorBody = z.infer<typeof CreateOperatorBody>;
export type CreateContractBody = z.infer<typeof CreateContractBody>;
export type EndContractBody = z.infer<typeof EndContractBody>;
export type OperatorReasonBody = z.infer<typeof OperatorReasonBody>;
export type OptionalReasonBody = OperatorReasonBody;
export type OperatorsQuery = z.infer<typeof OperatorsQuery>;
