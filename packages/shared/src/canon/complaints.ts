/**
 * Customer complaints (docs/v2/01 C-21/C-22, docs/v2/02 P-13; DEC-603, DEC-604; annex clauses 5 and 6: «تسجل الشكاوى
 * برقم مرجعي … وتكون … الشكاوى عبر تطبيق بوينت»). A complaint is registered from the app with a reference number
 * (`PT-C-000123`, from the sequence of `customer_complaints.ref_seq`), the customer follows its status, and the
 * platform console moves it (P-13) with an audited note. Nothing of a complaint is deleted.
 */
import { z } from 'zod';

export const COMPLAINT_CATEGORIES = [
  'service',
  'delay',
  'vehicle_damage',
  'lost_item',
  'payment',
  'subscription',
  'staff',
  'other',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];
export const ComplaintCategorySchema = z.enum(COMPLAINT_CATEGORIES);

/** `customer_complaints.status`: open → in_progress → resolved | closed (a closed one is answered without a fix). */
export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const ComplaintStatusSchema = z.enum(COMPLAINT_STATUSES);

/** The moves the console may make (P-13): a final status is final. */
export const COMPLAINT_TRANSITIONS: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: [],
  closed: [],
};

export const COMPLAINT_LIMITS = { body_min: 10, body_max: 2000, note_min: 3, note_max: 1000 } as const;

const REFERENCE = /^PT-C-(\d{6,})$/;

/** `PT-C-000123` of the sequence number 123 (six digits at least). */
export function complaintReference(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError('seq');
  return `PT-C-${String(seq).padStart(6, '0')}`;
}

/** The sequence number of a reference, or null when the text is not one (case and spaces ignored). */
export function complaintSeqOf(reference: string): number | null {
  const m = REFERENCE.exec(reference.trim().toUpperCase());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}
