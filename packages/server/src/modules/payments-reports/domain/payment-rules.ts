import type { PaymentMethod, PaymentStatus } from '@point/shared';
import { AppError } from '../../../core/errors/app-error.js';
import { latinDigits } from '../../tickets-custody/index.js';

/**
 * The collection rules of 13 §5 as pure functions (PNT-080). No card data ever (13 §2.1): `pos_reference` is
 * the terminal's short receipt / approval number only, normalized on the server before any check or storage
 * (13 §5.6) so the schema check `ck_payments_no_pan` sees the normalized text.
 */

/** The `PaymentInput` body (07): `method` + `amount_halalas` (+ `pos_reference` for `pos`). */
export interface PaymentInput {
  method: PaymentMethod;
  amount_halalas: number;
  pos_reference?: string | null;
}

export interface FieldIssue {
  field: string;
  issue: string;
}

/** 13 §5.6 rule 2: the stored shape after normalization. */
export const POS_REFERENCE_RE = /^[A-Z0-9]{1,24}$/;
/** 13 §5.6 rule 3 / `ck_payments_no_pan`: 13+ consecutive digits may be a card number (PAN 13–19). */
export const CARD_NUMBER_RE = /[0-9]{13,}/;

/**
 * 13 §5.6 rule 1: spaces and dashes removed, letters upper-cased (Arabic-Indic digits become Latin first,
 * DEC-17, so `٤١١١ ١١١١ …` is caught like `4111 1111 …`). An empty result is no reference.
 */
export function normalizePosReference(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = latinDigits(raw)
    .replace(/[\s\u00A0\u200B-\u200F\u2010-\u2015\u2212-]+/g, '')
    .toUpperCase();
  return v.length === 0 ? null : v;
}

/**
 * Input-shape rules of `pos_reference` (13 §5.2, §5.6): only with `pos` (`not_applicable` with cash), never
 * something that looks like a card number, and `^[A-Z0-9]{1,24}$` once normalized. `prefix` is the dotted path
 * of the payment object in the body (`''`, `payment.`, `replacement.`).
 */
export function posReferenceIssues(input: PaymentInput, prefix = ''): FieldIssue[] {
  const ref = normalizePosReference(input.pos_reference);
  if (ref === null) return [];
  const field = `${prefix}pos_reference`;
  if (input.method !== 'pos') return [{ field, issue: 'not_applicable' }];
  if (CARD_NUMBER_RE.test(ref)) return [{ field, issue: 'looks_like_card_number' }];
  if (!POS_REFERENCE_RE.test(ref)) return [{ field, issue: 'invalid_format' }];
  return [];
}

export function assertPaymentShape(input: PaymentInput, prefix = ''): void {
  const issues = posReferenceIssues(input, prefix);
  if (issues.length > 0) throw new AppError('VALIDATION_FAILED', { fields: issues });
}

/**
 * 13 §5.2 against the event and the ticket snapshot, in the table's order: the method must be one of the
 * event's methods at collection time (a policy read now, 13 §3), the amount exactly the ticket's fee snapshot
 * (`tickets.fee_halalas`, DEC-43: no partial payment, no surplus).
 */
export function assertPaymentMatches(
  input: PaymentInput,
  event: { allowed_payment_methods: readonly string[] },
  ticket: { fee_halalas: number },
): void {
  if (!event.allowed_payment_methods.includes(input.method)) {
    throw new AppError('PAYMENT_METHOD_NOT_ALLOWED', { allowed_methods: [...event.allowed_payment_methods] });
  }
  const expected = Number(ticket.fee_halalas);
  if (input.amount_halalas !== expected) {
    throw new AppError('PAYMENT_AMOUNT_MISMATCH', {
      expected_halalas: expected,
      received_halalas: input.amount_halalas,
    });
  }
}

/** `PaymentInput` as stored: the normalized reference (cash never keeps one). */
export function storedPosReference(input: PaymentInput): string | null {
  return input.method === 'pos' ? normalizePosReference(input.pos_reference) : null;
}

/**
 * Where a collection may happen on a ticket's money state (13 §15): only `due`. `collected` is a second
 * collection (PAYMENT_ALREADY_RECORDED, raised by the caller with the recorded payment's details); `not_required`
 * and `waived` are INVALID_STATE_TRANSITION with a reason (08 §4.10 note).
 */
export function paymentStatusBlocker(
  status: PaymentStatus,
): 'collected' | 'payment_not_required' | 'payment_waived' | null {
  if (status === 'due') return null;
  if (status === 'collected') return 'collected';
  return status === 'not_required' ? 'payment_not_required' : 'payment_waived';
}

// ------------------------------------------------------------------------------------------------
// display helpers (13 §2.3: integers in halalas, shown `20.00` with Latin digits; times in Asia/Riyadh)
// ------------------------------------------------------------------------------------------------

/** 2000 → `20.00`, −2000 → `-20.00` (exports `amount_sar`, 13 §13). */
export function formatSar(halalas: number): string {
  const n = Math.trunc(Number(halalas));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `20.00 ر.س` (13 §2.3). */
export const formatSarAr = (halalas: number): string => `${formatSar(halalas)} ر.س`;

const RIYADH = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `YYYY-MM-DD HH:mm` in Asia/Riyadh (13 §13), `''` for no time. */
export function formatRiyadh(d: Date | string | null | undefined, timeZone = 'Asia/Riyadh'): string {
  if (d == null) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const fmt =
    timeZone === 'Asia/Riyadh'
      ? RIYADH
      : new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The incident text of a cash handover difference (13 §10.2: expected, counted and difference in SAR). */
export function cashDifferenceDescription(expected: number, counted: number): string {
  const diff = counted - expected;
  return `فرق في تسليم النقد: المتوقع ${formatSarAr(expected)}، المعدود ${formatSarAr(counted)}، الفرق ${formatSarAr(diff)}`;
}

/** The incident text of a reversal without replacement on a delivered ticket (13 §7.1). */
export function deliveredDueDescription(displayNumber: number, amount: number): string {
  return `عكس تحصيل بلا بديل على تذكرة مسلّمة #${displayNumber}: ${formatSarAr(amount)} مستحقة`;
}
