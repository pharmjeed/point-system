import { roundHalfUpDiv, shareOfBp, type SaasCycle, type SettlementLineKind } from '@point/shared';

/**
 * The settlement formula of docs/v2/04 §5 as built (V2-041, DEC-545), pure: every source row of the month becomes
 * lines with a unique key, each amount rounded on its own (half-up), so the statement is exactly the sum of its lines
 * and every line can be traced to one ticket, payment, refund or venue-day share. The contract applied to a row is
 * the one in force on its Riyadh day (`starts_on ≤ day < ends_on`); a day with no contract applies zero.
 */

export interface ContractTerms {
  id: string;
  starts_on: string;
  ends_on: string | null;
  saas_fee_halalas_per_venue: number;
  saas_cycle: SaasCycle;
  subscriber_visit_payout_halalas: number;
  app_payment_commission_bp: number;
}

export interface MonthBounds {
  period: string;
  start: string;
  end: string;
  days: number;
}

const DAY_MS = 86_400_000;
const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
const dayStr = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** `2026-10` → 2026-10-01 … 2026-11-01 (exclusive), 31 days. */
export function monthBounds(period: string): MonthBounds {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const start = `${period}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { period, start, end, days: dayNum(end) - dayNum(start) };
}

/** The month before a Riyadh day, `YYYY-MM`. */
export function previousMonth(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function contractOn(contracts: readonly ContractTerms[], day: string): ContractTerms | null {
  return contracts.find((c) => c.starts_on <= day && (c.ends_on === null || day < c.ends_on)) ?? null;
}

export interface SourceVisit {
  ticket_id: string;
  venue_id: string;
  day: string;
}
export interface SourcePayment {
  payment_id: string;
  venue_id: string;
  day: string;
  amount_halalas: number;
}
export interface SourceRefund {
  refund_id: string;
  payment_id: string;
  venue_id: string;
  /** the Riyadh day the refund succeeded (the month it is settled in) */
  day: string;
  /** the Riyadh day its payment was paid (the contract of its commission) */
  paid_day: string;
  amount_halalas: number;
}
export interface SourceVenue {
  venue_id: string;
  /** the Riyadh day the venue was created (no fee before it) */
  from_day: string;
}

export interface ComputedLine {
  kind: SettlementLineKind;
  line_key: string;
  amount_halalas: number;
  base_halalas: number | null;
  rate_bp: number | null;
  quantity_days: number | null;
  occurred_on: string;
  venue_id: string | null;
  ticket_id: string | null;
  online_payment_id: string | null;
  refund_id: string | null;
  contract_id: string | null;
}

const line = (
  l: Partial<ComputedLine> & Pick<ComputedLine, 'kind' | 'line_key' | 'amount_halalas' | 'occurred_on'>,
): ComputedLine => ({
  base_halalas: null,
  rate_bp: null,
  quantity_days: null,
  venue_id: null,
  ticket_id: null,
  online_payment_id: null,
  refund_id: null,
  contract_id: null,
  ...l,
});

/**
 * The monthly share of a venue's system subscription under each contract in force during the month: the per-venue
 * fee (or a twelfth of the yearly one) × the days the venue had that contract ÷ the days of the month, half-up per
 * share. A venue counts from the day it was created.
 */
export function saasShares(
  contracts: readonly ContractTerms[],
  venue: SourceVenue,
  month: MonthBounds,
): { contract: ContractTerms; from: string; days: number; net: number }[] {
  const out: { contract: ContractTerms; from: string; days: number; net: number }[] = [];
  const first = Math.max(dayNum(month.start), dayNum(venue.from_day));
  const last = dayNum(month.end);
  for (const c of contracts) {
    const from = Math.max(first, dayNum(c.starts_on));
    const to = Math.min(last, c.ends_on ? dayNum(c.ends_on) : last);
    const days = to - from;
    if (days <= 0 || c.saas_fee_halalas_per_venue <= 0) continue;
    const den = month.days * (c.saas_cycle === 'yearly' ? 12 : 1);
    out.push({
      contract: c,
      from: dayStr(from),
      days,
      net: roundHalfUpDiv(c.saas_fee_halalas_per_venue * days, den),
    });
  }
  return out;
}

export interface SettlementSources {
  visits: readonly SourceVisit[];
  payments: readonly SourcePayment[];
  refunds: readonly SourceRefund[];
  venues: readonly SourceVenue[];
}

/** Every computed line of an operator's month (adjustments are added by hand, never computed). */
export function computeLines(
  sources: SettlementSources,
  contracts: readonly ContractTerms[],
  month: MonthBounds,
  vatRateBp: number,
): ComputedLine[] {
  const out: ComputedLine[] = [];
  for (const v of sources.visits) {
    const c = contractOn(contracts, v.day);
    out.push(
      line({
        kind: 'subscriber_visit',
        line_key: `subscriber_visit:${v.ticket_id}`,
        amount_halalas: c?.subscriber_visit_payout_halalas ?? 0,
        occurred_on: v.day,
        venue_id: v.venue_id,
        ticket_id: v.ticket_id,
        contract_id: c?.id ?? null,
      }),
    );
  }
  for (const p of sources.payments) {
    const c = contractOn(contracts, p.day);
    out.push(
      line({
        kind: 'app_payment',
        line_key: `app_payment:${p.payment_id}`,
        amount_halalas: p.amount_halalas,
        base_halalas: p.amount_halalas,
        occurred_on: p.day,
        venue_id: p.venue_id,
        online_payment_id: p.payment_id,
        contract_id: c?.id ?? null,
      }),
    );
    const bp = c?.app_payment_commission_bp ?? 0;
    const commission = shareOfBp(p.amount_halalas, bp);
    if (commission > 0)
      out.push(
        line({
          kind: 'app_commission',
          line_key: `app_commission:${p.payment_id}`,
          amount_halalas: -commission,
          base_halalas: p.amount_halalas,
          rate_bp: bp,
          occurred_on: p.day,
          venue_id: p.venue_id,
          online_payment_id: p.payment_id,
          contract_id: c?.id ?? null,
        }),
      );
  }
  for (const r of sources.refunds) {
    const c = contractOn(contracts, r.paid_day);
    out.push(
      line({
        kind: 'app_refund',
        line_key: `app_refund:${r.refund_id}`,
        amount_halalas: -r.amount_halalas,
        base_halalas: r.amount_halalas,
        occurred_on: r.day,
        venue_id: r.venue_id,
        online_payment_id: r.payment_id,
        refund_id: r.refund_id,
        contract_id: c?.id ?? null,
      }),
    );
    const bp = c?.app_payment_commission_bp ?? 0;
    const back = shareOfBp(r.amount_halalas, bp);
    if (back > 0)
      out.push(
        line({
          kind: 'app_refund_commission',
          line_key: `app_refund_commission:${r.refund_id}`,
          amount_halalas: back,
          base_halalas: r.amount_halalas,
          rate_bp: bp,
          occurred_on: r.day,
          venue_id: r.venue_id,
          online_payment_id: r.payment_id,
          refund_id: r.refund_id,
          contract_id: c?.id ?? null,
        }),
      );
  }
  for (const v of sources.venues) {
    for (const s of saasShares(contracts, v, month)) {
      const key = `${v.venue_id}:${month.period}:${s.contract.id}`;
      out.push(
        line({
          kind: 'saas_fee',
          line_key: `saas_fee:${key}`,
          amount_halalas: -s.net,
          base_halalas: s.contract.saas_fee_halalas_per_venue,
          quantity_days: s.days,
          occurred_on: s.from,
          venue_id: v.venue_id,
          contract_id: s.contract.id,
        }),
      );
      const vat = shareOfBp(s.net, vatRateBp);
      if (vat > 0)
        out.push(
          line({
            kind: 'saas_vat',
            line_key: `saas_vat:${key}`,
            amount_halalas: -vat,
            base_halalas: s.net,
            rate_bp: vatRateBp,
            occurred_on: s.from,
            venue_id: v.venue_id,
            contract_id: s.contract.id,
          }),
        );
    }
  }
  return out;
}

export interface StatementTotals {
  subscriber_visit_count: number;
  subscriber_payout_halalas: number;
  app_payment_count: number;
  app_gross_halalas: number;
  app_commission_halalas: number;
  app_refund_halalas: number;
  app_refund_commission_halalas: number;
  saas_fee_halalas: number;
  saas_vat_halalas: number;
  adjustments_halalas: number;
  net_payable_halalas: number;
}

/** The header of a statement from its active lines (the same rule as the database's trg_settlement_totals). */
export function totalsOf(lines: readonly Pick<ComputedLine, 'kind' | 'amount_halalas'>[]): StatementTotals {
  const sum = (k: SettlementLineKind) =>
    lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount_halalas, 0);
  const count = (k: SettlementLineKind) => lines.filter((l) => l.kind === k).length;
  return {
    subscriber_visit_count: count('subscriber_visit'),
    subscriber_payout_halalas: sum('subscriber_visit'),
    app_payment_count: count('app_payment'),
    app_gross_halalas: sum('app_payment'),
    app_commission_halalas: -sum('app_commission'),
    app_refund_halalas: -sum('app_refund'),
    app_refund_commission_halalas: sum('app_refund_commission'),
    saas_fee_halalas: -sum('saas_fee'),
    saas_vat_halalas: -sum('saas_vat'),
    adjustments_halalas: sum('adjustment'),
    net_payable_halalas: lines.reduce((a, l) => a + l.amount_halalas, 0),
  };
}
