import { VENUE_SETTINGS_DEFAULTS, venueSettingsSchema } from '@point/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors/app-error.js';
import { existingLabelIssues, expandLabels } from '../src/modules/venues-events/domain/labels.js';
import { parseSettingsInput, zodIssuesToFields } from '../src/modules/venues-events/domain/settings.js';
import { ListCursorCodec, pageOf } from '../src/modules/venues-events/infra/cursor.js';

// PNT-018 — pure rules of the venue setup: bulk labels, list cursors, settings input.

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};
const issues = (list: { field: string; issue: string }[]) => list.map((i) => `${i.field}:${i.issue}`);

describe('bulk labels (parking spots, key slots)', () => {
  it('exactly one of labels/range', () => {
    expect(issues(expandLabels({}).issues)).toEqual(['labels:labels_or_range']);
    expect(issues(expandLabels({ labels: ['A'], range: { from: 1, to: 2 } }).issues)).toEqual([
      'range:labels_or_range',
    ]);
  });

  it('labels are trimmed; empty, too long and repeated labels are reported at their index', () => {
    const r = expandLabels({ labels: [' A-1 ', 'A-2', '', 'A-1', 'x'.repeat(21), 'A-2'] });
    expect(r.labels.slice(0, 2)).toEqual(['A-1', 'A-2']);
    expect(issues(r.issues)).toEqual([
      'labels.2:required',
      'labels.3:duplicate',
      'labels.4:too_long',
      'labels.5:duplicate',
    ]);
    expect(r.issues[1]).toMatchObject({ index: 3, label: 'A-1', duplicate_of: 0 });
    expect(issues(expandLabels({ labels: [] }).issues)).toEqual(['labels:required']);
    expect(issues(expandLabels({ labels: Array.from({ length: 501 }, (_, i) => `L${i}`) }).issues)).toEqual([
      'labels:too_many',
    ]);
  });

  it('a range zero-pads to the width of `to` with a prefix, and is plain without one', () => {
    expect(expandLabels({ range: { prefix: 'A-', from: 1, to: 40 } }).labels.slice(0, 3)).toEqual([
      'A-01',
      'A-02',
      'A-03',
    ]);
    expect(expandLabels({ range: { prefix: 'B-', from: 98, to: 101 } }).labels).toEqual([
      'B-098',
      'B-099',
      'B-100',
      'B-101',
    ]);
    expect(expandLabels({ range: { from: 1, to: 120 } }).labels.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(expandLabels({ range: { prefix: '  ', from: 9, to: 10 } }).labels).toEqual(['9', '10']);
    expect(expandLabels({ range: { from: 5, to: 5 } }).labels).toEqual(['5']);
  });

  it('a reversed, oversized or too long range is rejected', () => {
    expect(issues(expandLabels({ range: { from: 3, to: 2 } }).issues)).toEqual(['range.to:before_from']);
    expect(issues(expandLabels({ range: { from: 1, to: 501 } }).issues)).toEqual(['range:too_many']);
    expect(expandLabels({ range: { from: 1, to: 500 } }).labels).toHaveLength(500);
    expect(
      issues(expandLabels({ range: { prefix: 'PREFIX-10', from: 1, to: 10_000_000_000 } }).issues),
    ).toEqual(['range:too_many']);
    expect(
      issues(expandLabels({ range: { prefix: 'ABCDEFGHIJ', from: 12345678901, to: 12345678901 } }).issues),
    ).toEqual(['range:label_too_long']);
  });

  it('labels that already exist are reported with their index (labels.n or range)', () => {
    const list = expandLabels({ labels: ['A-1', 'A-2', 'A-3'] });
    expect(existingLabelIssues(list, new Set(['A-3', 'A-1']))).toEqual([
      expect.objectContaining({ field: 'labels.0', issue: 'duplicate', label: 'A-1', index: 0 }),
      expect.objectContaining({ field: 'labels.2', issue: 'duplicate', label: 'A-3', index: 2 }),
    ]);
    const range = expandLabels({ range: { prefix: 'A-', from: 1, to: 3 } });
    expect(existingLabelIssues(range, new Set(['A-2']))).toEqual([
      expect.objectContaining({ field: 'range', issue: 'duplicate', label: 'A-2', index: 1 }),
    ]);
  });
});

describe('list cursors', () => {
  const codec = new ListCursorCodec('a'.repeat(44));

  it('round-trips and is bound to its scope and arity', () => {
    const c = codec.encode('spots|v1', [1, 'B', 'z1', 'A-', '07', 'A-07', 'id1']);
    expect(codec.decode(c, 'spots|v1', 7)).toEqual([1, 'B', 'z1', 'A-', '07', 'A-07', 'id1']);
    expect(code(() => codec.decode(c, 'spots|v2', 7))).toBe('PAGINATION_CURSOR_INVALID');
    expect(code(() => codec.decode(c, 'spots|v1', 6))).toBe('PAGINATION_CURSOR_INVALID');
  });

  it('rejects tampering: body, signature, trailing characters, another key, garbage', () => {
    const c = codec.encode('venues|', ['RMS', 'id']);
    const [body, mac] = c.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ s: 'venues|', v: ['AAA', 'id'] })).toString('base64url');
    const flipped = `${body}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [`${forged}.${mac}`, flipped, `${c}x`, `${c}.x`, 'abc', '', '.']) {
      expect(code(() => codec.decode(bad, 'venues|', 2))).toBe('PAGINATION_CURSOR_INVALID');
    }
    expect(code(() => new ListCursorCodec('b'.repeat(44)).decode(c, 'venues|', 2))).toBe(
      'PAGINATION_CURSOR_INVALID',
    );
  });

  it('pageOf returns limit rows and a cursor only when there is more', () => {
    const rows = [1, 2, 3];
    expect(
      pageOf(
        rows,
        2,
        (x) => x * 10,
        (x) => `c${x}`,
      ),
    ).toEqual({ data: [10, 20], next_cursor: 'c2' });
    expect(
      pageOf(
        rows,
        3,
        (x) => x,
        (x) => `c${x}`,
      ),
    ).toEqual({ data: [1, 2, 3], next_cursor: null });
  });
});

describe('venue settings input', () => {
  it('unknown keys are reported at their own dotted path', () => {
    const r = parseSettingsInput({ dispatch: { foo: 1, bar: 2 }, nope: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(issues(r.fields)).toEqual(
      expect.arrayContaining([
        'settings.dispatch.foo:unrecognized_key',
        'settings.dispatch.bar:unrecognized_key',
        'settings.nope:unrecognized_key',
      ]),
    );
  });

  it('a partial object is completed with the canon §12 defaults', () => {
    const r = parseSettingsInput({ ready: { uncollected_alert_min: 15 } });
    expect(r).toEqual({
      ok: true,
      settings: { ...VENUE_SETTINGS_DEFAULTS, ready: { uncollected_alert_min: 15 } },
    });
  });

  it('root-level issues keep the (body) marker only when there is no path', () => {
    const e = venueSettingsSchema.safeParse('x');
    expect(e.success).toBe(false);
    if (!e.success) expect(issues(zodIssuesToFields(e.error))).toEqual(['(body):invalid_type']);
  });
});
