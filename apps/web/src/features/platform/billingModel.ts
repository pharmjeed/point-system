import { SETTLEMENT_ADJUSTABLE_STATUSES, SETTLEMENT_TRANSITIONS } from '@shared/canon/invoicing';
import type { PlatformMe } from '@/api/platform';
import type {
  SettlementCommandName,
  SettlementStatement,
  SettlementStatus,
  ZatcaStatus,
} from '@/api/billing';
import { platformCan, sarToHalalas, type ChipTone } from './platformModel';

/**
 * Pure rules of P-09 / P-10 and O-05 / O-06 (V2-040 … V2-042): what to offer for a statement's status and how to read a
 * form before it is sent. The server decides (permissions, transitions, versions, the amounts) and these mirror it.
 */

export const SETTLEMENT_TONE: Record<SettlementStatus, ChipTone> = {
  draft: 'info',
  issued: 'warning',
  disputed: 'danger',
  paid: 'success',
  void: 'neutral',
};

export const ZATCA_TONE: Record<ZatcaStatus, ChipTone> = {
  pending: 'info',
  reported: 'success',
  cleared: 'success',
  rejected: 'danger',
};

export type StatementAction = 'adjust' | SettlementCommandName;

const COMMAND_OF: Record<SettlementCommandName, keyof typeof SETTLEMENT_TRANSITIONS> = {
  issue: 'issue',
  'record-payment': 'record_payment',
  'resolve-dispute': 'resolve_dispute',
  void: 'void',
};

/** The P-09 actions on a statement: `platform.settlement_manage` and a status that allows them (docs/v2/04 §5). */
export function statementActions(me: PlatformMe, status: SettlementStatus): StatementAction[] {
  if (!platformCan(me, 'platform.settlement_manage')) return [];
  const out: StatementAction[] = [];
  if ((SETTLEMENT_ADJUSTABLE_STATUSES as readonly string[]).includes(status)) out.push('adjust');
  for (const c of ['issue', 'resolve-dispute', 'record-payment', 'void'] as const)
    if ((SETTLEMENT_TRANSITIONS[COMMAND_OF[c]].from as readonly string[]).includes(status)) out.push(c);
  return out;
}

/** O-05: the operator disputes an issued statement of its own (`settlement.dispute`, the server checks it). */
export const operatorCanDispute = (permissions: readonly string[], status: SettlementStatus) =>
  permissions.includes('settlement.dispute') && status === 'issued';

/** «-12.50» → −1250 halalas: a signed adjustment, never zero; null when it is not an amount. */
export function adjustmentHalalas(input: string): number | null {
  const v = input.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const negative = v.startsWith('-') || v.startsWith('−');
  const h = sarToHalalas(negative ? v.slice(1) : v);
  if (h === null || h === 0) return null;
  return negative ? -h : h;
}

/** `YYYY-MM` of a closed month: the month before today in Riyadh is the default of «إعداد مسودات شهر». */
export function previousMonth(now: Date): string {
  const r = new Date(now.getTime() + 3 * 3_600_000);
  const y = r.getUTCFullYear();
  const m = r.getUTCMonth(); // 0-based: the previous month's number
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

export const isPeriod = (s: string) => /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(s);

export type NetDirection = 'point_pays' | 'operator_pays' | 'nothing';
export const netDirection = (net: number): NetDirection =>
  net > 0 ? 'point_pays' : net < 0 ? 'operator_pays' : 'nothing';

export interface BreakdownRow {
  key:
    | 'subscriberVisits'
    | 'appGross'
    | 'appCommission'
    | 'appRefunds'
    | 'appRefundCommission'
    | 'saasFee'
    | 'saasVat'
    | 'adjustments';
  /** the signed effect on the net (positive: POINT pays the operator) */
  halalas: number;
  count?: number;
}

/** The statement's header as signed rows that add up to its net (the same rule as the server's lines). */
export function breakdown(s: SettlementStatement): BreakdownRow[] {
  return [
    { key: 'subscriberVisits', halalas: s.subscriber_payout_halalas, count: s.subscriber_visit_count },
    { key: 'appGross', halalas: s.app_gross_halalas, count: s.app_payment_count },
    { key: 'appCommission', halalas: -s.app_commission_halalas },
    { key: 'appRefunds', halalas: -s.app_refund_halalas },
    { key: 'appRefundCommission', halalas: s.app_refund_commission_halalas },
    { key: 'saasFee', halalas: -s.saas_fee_halalas },
    { key: 'saasVat', halalas: -s.saas_vat_halalas },
    { key: 'adjustments', halalas: s.adjustments_halalas },
  ];
}
