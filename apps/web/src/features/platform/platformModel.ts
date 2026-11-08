import { OPERATOR_TRANSITIONS } from '@shared/canon/platform';
import type {
  CreateContractInput,
  CreateOperatorInput,
  OperatorCommand,
  OperatorStatus,
  PlatformMe,
} from '@/api/platform';
import { normalizeSaudiMobile } from '@/lib/phone';

/**
 * Pure rules of the platform console screens P-01 … P-03 (V2-003). The server decides (permissions, transitions, overlaps); these only choose what to show and validate a form
 * before it is sent.
 */

export type PlatformPermission =
  | 'platform.overview_read'
  | 'platform.operator_read'
  | 'platform.operator_manage'
  | 'platform.venue_review'
  | 'platform.customer_read'
  | 'platform.customer_manage'
  | 'platform.payment_read'
  | 'platform.refund_issue'
  | 'platform.plan_manage'
  | 'platform.subscription_read'
  | 'platform.settlement_manage'
  | 'platform.invoice_read';

export const platformCan = (me: PlatformMe, permission: PlatformPermission) =>
  me.permissions.includes(permission);

export type PlatformDestination =
  | 'overview'
  | 'operators'
  | 'venues'
  | 'customers'
  | 'payments'
  | 'plans'
  | 'subscriptions'
  | 'settlements'
  | 'invoices';

/**
 * The console's destinations for this account (P-02 / P-03 need `platform.operator_read`, P-04
 * `platform.venue_review`, V2-004; P-06 `platform.customer_read` and P-08 `platform.payment_read`, V2-024).
 */
export function platformNav(me: PlatformMe): PlatformDestination[] {
  return [
    'overview' as const,
    ...(platformCan(me, 'platform.operator_read') ? (['operators'] as const) : []),
    ...(platformCan(me, 'platform.venue_review') ? (['venues'] as const) : []),
    ...(platformCan(me, 'platform.customer_read') ? (['customers'] as const) : []),
    ...(platformCan(me, 'platform.payment_read') ? (['payments'] as const) : []),
    // V2-030 / V2-035: P-05 `platform.plan_manage`, P-07 `platform.subscription_read`
    ...(platformCan(me, 'platform.plan_manage') ? (['plans'] as const) : []),
    ...(platformCan(me, 'platform.subscription_read') ? (['subscriptions'] as const) : []),
    // V2-041 / V2-040: P-09 with `platform.settlement_manage`, P-10 with `platform.invoice_read`
    ...(platformCan(me, 'platform.settlement_manage') ? (['settlements'] as const) : []),
    ...(platformCan(me, 'platform.invoice_read') ? (['invoices'] as const) : []),
  ];
}

const COMMANDS: OperatorCommand[] = ['activate', 'suspend', 'reactivate', 'terminate'];

/** The lifecycle commands offered on P-03: the account may manage, and the status allows (02 §4, DEC-486). */
export function operatorCommands(me: PlatformMe, status: OperatorStatus): OperatorCommand[] {
  if (!platformCan(me, 'platform.operator_manage')) return [];
  return COMMANDS.filter((c) => (OPERATOR_TRANSITIONS[c].from as readonly string[]).includes(status));
}

/** Suspend and terminate need a recorded reason (3+ characters, REASON_REQUIRED); terminate is destructive. */
export const commandNeedsReason = (c: OperatorCommand) => c === 'suspend' || c === 'terminate';
export const commandIsDestructive = (c: OperatorCommand) => c === 'suspend' || c === 'terminate';
export const MIN_REASON = 3;

export type ChipTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export const OPERATOR_TONE: Record<OperatorStatus, ChipTone> = {
  invited: 'info',
  trial: 'info',
  active: 'success',
  suspended: 'warning',
  terminated: 'danger',
};

// ------------------------------------------------------------------------------------------- forms

export interface OperatorForm {
  name_ar: string;
  name_en: string;
  legal_name: string;
  cr_number: string;
  vat_number: string;
  operator_status: 'trial' | 'active';
  owner_name: string;
  owner_phone: string;
}

export const BLANK_OPERATOR: OperatorForm = {
  name_ar: '',
  name_en: '',
  legal_name: '',
  cr_number: '',
  vat_number: '',
  operator_status: 'trial',
  owner_name: '',
  owner_phone: '',
};

export type OperatorFormIssue = 'required' | 'cr_invalid' | 'vat_invalid' | 'phone_invalid';

/** Field → issue for the P-02 form (the server checks again: zod and the database checks of 0008). */
export function validateOperatorForm(
  f: OperatorForm,
): { ok: true; body: CreateOperatorInput } | { ok: false; issues: Record<string, OperatorFormIssue> } {
  const issues: Record<string, OperatorFormIssue> = {};
  const trim = (v: string) => v.trim();
  if (trim(f.name_ar).length < 2) issues.name_ar = 'required';
  if (trim(f.legal_name).length < 2) issues.legal_name = 'required';
  const cr = trim(f.cr_number);
  if (cr && !/^[0-9]{10}$/.test(cr)) issues.cr_number = 'cr_invalid';
  const vat = trim(f.vat_number);
  if (vat && !/^3[0-9]{13}3$/.test(vat)) issues.vat_number = 'vat_invalid';
  if (trim(f.owner_name).length < 2) issues['owner.full_name'] = 'required';
  const phone = normalizeSaudiMobile(f.owner_phone);
  if (!phone) issues['owner.phone'] = 'phone_invalid';
  if (Object.keys(issues).length || !phone) return { ok: false, issues };
  return {
    ok: true,
    body: {
      name_ar: trim(f.name_ar),
      name_en: trim(f.name_en) || null,
      legal_name: trim(f.legal_name),
      cr_number: cr || null,
      vat_number: vat || null,
      operator_status: f.operator_status,
      owner: { full_name: trim(f.owner_name), phone },
    },
  };
}

/** «12.50» riyals → 1250 halalas; null when not a non-negative amount with at most two decimals. */
export function sarToHalalas(input: string): number | null {
  const v = input.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!/^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** «2.5» percent → 250 basis points (0 … 10000). */
export function percentToBp(input: string): number | null {
  const h = sarToHalalas(input);
  return h === null || h > 10_000 ? null : h;
}

/** 250 basis points → «2.50%». */
export const bpToPercent = (bp: number) => `${(bp / 100).toFixed(2)}%`;

const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export function isCalendarDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface ContractForm {
  saas_fee: string;
  saas_cycle: 'monthly' | 'yearly';
  payout: string;
  commission: string;
  starts_on: string;
  ends_on: string;
}

export type ContractFormIssue = 'amount' | 'percent' | 'date' | 'end_before_start';

export function validateContractForm(
  f: ContractForm,
): { ok: true; body: CreateContractInput } | { ok: false; issues: Record<string, ContractFormIssue> } {
  const issues: Record<string, ContractFormIssue> = {};
  const fee = sarToHalalas(f.saas_fee);
  const payout = sarToHalalas(f.payout);
  const bp = percentToBp(f.commission);
  if (fee === null) issues.saas_fee_halalas_per_venue = 'amount';
  if (payout === null) issues.subscriber_visit_payout_halalas = 'amount';
  if (bp === null) issues.app_payment_commission_bp = 'percent';
  if (!isCalendarDate(f.starts_on)) issues.starts_on = 'date';
  const end = f.ends_on.trim();
  if (end && !isCalendarDate(end)) issues.ends_on = 'date';
  else if (end && isCalendarDate(f.starts_on) && end <= f.starts_on) issues.ends_on = 'end_before_start';
  if (Object.keys(issues).length || fee === null || payout === null || bp === null)
    return { ok: false, issues };
  return {
    ok: true,
    body: {
      saas_fee_halalas_per_venue: fee,
      saas_cycle: f.saas_cycle,
      subscriber_visit_payout_halalas: payout,
      app_payment_commission_bp: bp,
      starts_on: f.starts_on,
      ends_on: end || null,
    },
  };
}
