import type { FieldIssue } from './errors.js';

/** Bulk creation of parking spots and key slots (07 `createParkingSpots` / `createKeySlots`). */
export const MAX_BULK_LABELS = 500;
export const MAX_LABEL_LENGTH = 20;

export interface LabelRange {
  prefix?: string | undefined;
  from: number;
  to: number;
}

export interface LabelSpec {
  labels?: string[] | undefined;
  range?: LabelRange | undefined;
}

export interface ExpandedLabels {
  labels: string[];
  /** `labels` (explicit list) or `range` — where the n-th label came from, for error fields. */
  source: 'labels' | 'range';
  issues: FieldIssue[];
}

/**
 * Expands `labels` or `range` (exactly one, 07: «أرسل labels أو range») into the final label list.
 *
 * - Explicit labels are trimmed; empty or longer than 20 characters are rejected, and a label repeated inside the
 *   request is reported at the index of every repetition (08 §5.2: the duplicate indexes are named).
 * - A range produces `prefix + n` for n = from…to. With a prefix the number is zero-padded to the digit count of
 *   `to` («A-01 إلى A-40» in 02 S-09 → A-01…A-40); without a prefix it is plain («1 إلى 120» → 1…120, as the seeded
 *   key slots). At most 500 labels either way.
 */
export function expandLabels(spec: LabelSpec): ExpandedLabels {
  const hasLabels = spec.labels !== undefined;
  const hasRange = spec.range !== undefined;
  if (hasLabels === hasRange) {
    return {
      labels: [],
      source: 'labels',
      issues: [
        {
          field: hasLabels ? 'range' : 'labels',
          issue: 'labels_or_range',
          message_ar: 'أرسل قائمة الملصقات أو نطاقًا واحدًا (واحد منهما فقط).',
        },
      ],
    };
  }
  if (hasLabels) return fromList(spec.labels!);
  return fromRange(spec.range!);
}

function fromList(raw: string[]): ExpandedLabels {
  const issues: FieldIssue[] = [];
  const labels = raw.map((l) => l.trim());
  if (labels.length === 0) {
    issues.push({ field: 'labels', issue: 'required', message_ar: 'أضف ملصقًا واحدًا على الأقل.' });
  }
  if (labels.length > MAX_BULK_LABELS) {
    issues.push({ field: 'labels', issue: 'too_many', max: MAX_BULK_LABELS });
  }
  const seen = new Map<string, number>();
  labels.forEach((label, i) => {
    if (label.length === 0) {
      issues.push({ field: `labels.${i}`, issue: 'required', index: i });
      return;
    }
    if (label.length > MAX_LABEL_LENGTH) {
      issues.push({ field: `labels.${i}`, issue: 'too_long', index: i, max: MAX_LABEL_LENGTH });
      return;
    }
    const first = seen.get(label);
    if (first !== undefined) {
      issues.push({
        field: `labels.${i}`,
        issue: 'duplicate',
        index: i,
        label,
        duplicate_of: first,
        message_ar: `الملصق ${label} مكرر في الطلب.`,
      });
    } else {
      seen.set(label, i);
    }
  });
  return { labels, source: 'labels', issues };
}

function fromRange(range: LabelRange): ExpandedLabels {
  const issues: FieldIssue[] = [];
  const prefix = (range.prefix ?? '').trim();
  if (range.to < range.from) {
    issues.push({ field: 'range.to', issue: 'before_from', message_ar: 'نهاية النطاق قبل بدايته.' });
    return { labels: [], source: 'range', issues };
  }
  const count = range.to - range.from + 1;
  if (count > MAX_BULK_LABELS) {
    issues.push({ field: 'range', issue: 'too_many', max: MAX_BULK_LABELS, count });
    return { labels: [], source: 'range', issues };
  }
  const width = prefix ? String(range.to).length : 0;
  const labels: string[] = [];
  for (let n = range.from; n <= range.to; n++) labels.push(prefix + String(n).padStart(width, '0'));
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest > MAX_LABEL_LENGTH) {
    issues.push({ field: 'range', issue: 'label_too_long', max: MAX_LABEL_LENGTH });
  }
  return { labels, source: 'range', issues };
}

/** VALIDATION_FAILED fields for labels that already exist in the zone/board (08 §5.2, indexes named). */
export function existingLabelIssues(expanded: ExpandedLabels, existing: ReadonlySet<string>): FieldIssue[] {
  const issues: FieldIssue[] = [];
  expanded.labels.forEach((label, i) => {
    if (!existing.has(label)) return;
    issues.push({
      field: expanded.source === 'labels' ? `labels.${i}` : 'range',
      issue: 'duplicate',
      index: i,
      label,
      message_ar: `الملصق ${label} موجود بالفعل.`,
    });
  });
  return issues;
}
