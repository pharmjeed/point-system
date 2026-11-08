import type { Reconciliation, ReconciliationBlockers, Settlement } from '@/api/types';
import { onlyDigits, toLatinDigits } from '@/lib/digits';

/**
 * S-10 close model (02 S-10, 13 §12): the summary counters and which blocker lists are ✗. `blockers` has the
 * same shape in `GET …/reconciliation` and in EVENT_CLOSE_BLOCKED `details.blockers` (07), so a refused close
 * replaces the lists with the server's (`withBlockers`).
 */
export type BlockerKey = keyof ReconciliationBlockers;

export const BLOCKER_KEYS: BlockerKey[] = [
  'open_tickets',
  'keys_not_in_slots',
  'open_requests',
  'open_tasks',
  'unsettled_payments',
  'cash_outstanding',
  'payment_integrity',
];

export function openBlockers(b: ReconciliationBlockers): BlockerKey[] {
  return BLOCKER_KEYS.filter((k) => (b[k]?.length ?? 0) > 0);
}

export const cashOutstandingHalalas = (b: ReconciliationBlockers) =>
  b.cash_outstanding.reduce((sum, c) => sum + c.amount_halalas, 0);

/** Reconciliation with the blockers of an EVENT_CLOSE_BLOCKED reply (missing lists stay as they were). */
export function withBlockers(rec: Reconciliation, details: Record<string, unknown>): Reconciliation {
  const raw = details.blockers;
  if (!raw || typeof raw !== 'object') return rec;
  const next = { ...rec.blockers };
  for (const k of BLOCKER_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (Array.isArray(v)) (next as Record<string, unknown>)[k] = v;
  }
  return { ...rec, blockers: next, can_close: openBlockers(next).length === 0 };
}

/** Per-driver cash lines of the settlement (13 §10.3): only drivers with cash activity. */
export const cashDrivers = (s: Settlement) =>
  s.drivers.filter(
    (d) => d.cash.count > 0 || d.cash.handed_over_halalas > 0 || d.cash.outstanding_halalas > 0,
  );

/**
 * «المبلغ المستلم» typed in riyals («150» / «150.5» / «١٥٠٫٥٠») → halalas; null when not a valid amount
 * (07 §1.8: integer halalas, ≥ 0, two decimals at most).
 */
export function riyalsToHalalas(input: string): number | null {
  const s = toLatinDigits(input).trim().replace('٫', '.').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  return Number(onlyDigits(whole)) * 100 + Number((frac + '00').slice(0, 2));
}
