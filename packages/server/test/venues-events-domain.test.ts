import { VENUE_SETTINGS_DEFAULTS, venueSettingsSchema } from '@point/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors/app-error.js';
import {
  assertCancelable,
  assertEventEditable,
  assertPoolChangeAllowed,
  openTransition,
  requireReason,
} from '../src/modules/venues-events/domain/event-lifecycle.js';
import {
  mergedPricing,
  newEventPricing,
  pricingIssues,
  scheduleIssues,
} from '../src/modules/venues-events/domain/pricing.js';

// PNT-019 — pure rules of the event lifecycle: pricing and the state guards.

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};
const issues = (list: { field: string; issue: string }[]) => list.map((i) => `${i.field}:${i.issue}`);

describe('event pricing (13 §3)', () => {
  it('included ⇒ fee 0, per_vehicle ⇒ fee > 0, methods non-empty and unique', () => {
    expect(
      pricingIssues({ pricing_mode: 'included', fee_halalas: 0, allowed_payment_methods: ['cash'] }),
    ).toEqual([]);
    expect(
      pricingIssues({ pricing_mode: 'per_vehicle', fee_halalas: 2000, allowed_payment_methods: ['pos'] }),
    ).toEqual([]);
    expect(
      issues(pricingIssues({ pricing_mode: 'included', fee_halalas: 1, allowed_payment_methods: ['cash'] })),
    ).toEqual(['fee_halalas:must_be_zero_when_included']);
    expect(
      issues(
        pricingIssues({ pricing_mode: 'per_vehicle', fee_halalas: 0, allowed_payment_methods: ['cash'] }),
      ),
    ).toEqual(['fee_halalas:positive_required_when_per_vehicle']);
    expect(
      issues(pricingIssues({ pricing_mode: 'included', fee_halalas: 0, allowed_payment_methods: [] })),
    ).toEqual(['allowed_payment_methods:required']);
    expect(
      issues(
        pricingIssues({ pricing_mode: 'included', fee_halalas: 0, allowed_payment_methods: ['pos', 'pos'] }),
      ),
    ).toEqual(['allowed_payment_methods:duplicate']);
  });

  it('a new event takes fee and methods from the venue settings when not sent', () => {
    const defaults = { pricing: VENUE_SETTINGS_DEFAULTS.pricing } as never;
    expect(newEventPricing({ pricing_mode: 'per_vehicle' }, defaults)).toEqual({
      pricing_mode: 'per_vehicle',
      fee_halalas: 0,
      allowed_payment_methods: ['cash', 'pos'],
    });
    const paid = venueSettingsSchema.parse({
      pricing: { default_mode: 'per_vehicle', default_fee_halalas: 1500, allowed_methods: ['cash'] },
    });
    expect(newEventPricing({ pricing_mode: 'per_vehicle' }, paid)).toEqual({
      pricing_mode: 'per_vehicle',
      fee_halalas: 1500,
      allowed_payment_methods: ['cash'],
    });
    expect(newEventPricing({ pricing_mode: 'included' }, paid).fee_halalas).toBe(0);
    expect(
      newEventPricing(
        { pricing_mode: 'per_vehicle', fee_halalas: 900, allowed_payment_methods: ['pos'] },
        paid,
      ),
    ).toEqual({
      pricing_mode: 'per_vehicle',
      fee_halalas: 900,
      allowed_payment_methods: ['pos'],
    });
  });

  it('PATCH validates the merged pricing', () => {
    const current = {
      pricing_mode: 'per_vehicle' as const,
      fee_halalas: 2000,
      allowed_payment_methods: ['cash' as const],
    };
    expect(mergedPricing(current, { pricing_mode: 'included' })).toEqual({
      ...current,
      pricing_mode: 'included',
    });
    expect(mergedPricing(current, { fee_halalas: 3000, allowed_payment_methods: ['pos'] })).toEqual({
      pricing_mode: 'per_vehicle',
      fee_halalas: 3000,
      allowed_payment_methods: ['pos'],
    });
  });

  it('ends_at before starts_at is rejected', () => {
    expect(issues(scheduleIssues('2026-10-30T20:00:00Z', '2026-10-30T19:59:59Z'))).toEqual([
      'ends_at:before_starts_at',
    ]);
    expect(scheduleIssues('2026-10-30T20:00:00Z', '2026-10-30T20:00:00Z')).toEqual([]);
    expect(scheduleIssues(null, '2026-10-30T20:00:00Z')).toEqual([]);
  });
});

describe('event lifecycle guards (11 §6.4)', () => {
  const ev = (status: 'draft' | 'open' | 'closing' | 'closed' | 'canceled') => ({
    id: 'e1',
    status,
    version: 3,
  });
  const cmd = 'POST /v1/events/{eventId}/open';

  it('open: draft → open, closing → open (reopened); open → INVALID_STATE_TRANSITION; final → EVENT_ALREADY_CLOSED', () => {
    expect(openTransition(ev('draft'), cmd)).toEqual({ reopened: false });
    expect(openTransition(ev('closing'), cmd)).toEqual({ reopened: true });
    expect(code(() => openTransition(ev('open'), cmd))).toBe('INVALID_STATE_TRANSITION');
    expect(code(() => openTransition(ev('closed'), cmd))).toBe('EVENT_ALREADY_CLOSED');
    expect(code(() => openTransition(ev('canceled'), cmd))).toBe('EVENT_ALREADY_CLOSED');
    try {
      openTransition(ev('open'), cmd);
    } catch (e) {
      expect((e as AppError).details).toEqual({
        entity_type: 'event',
        entity_id: 'e1',
        current_status: 'open',
        current_version: 3,
        command: cmd,
        allowed_from: ['draft', 'closing'],
      });
    }
  });

  it('PATCH and cancel: draft/open only; closing → INVALID_STATE_TRANSITION; final → EVENT_ALREADY_CLOSED', () => {
    for (const s of ['draft', 'open'] as const) {
      expect(code(() => assertEventEditable(ev(s), cmd))).toBeNull();
      expect(code(() => assertCancelable(ev(s), cmd))).toBeNull();
    }
    expect(code(() => assertEventEditable(ev('closing'), cmd))).toBe('INVALID_STATE_TRANSITION');
    expect(code(() => assertCancelable(ev('closing'), cmd))).toBe('INVALID_STATE_TRANSITION');
    for (const s of ['closed', 'canceled'] as const) {
      expect(code(() => assertEventEditable(ev(s), cmd))).toBe('EVENT_ALREADY_CLOSED');
      expect(code(() => assertCancelable(ev(s), cmd))).toBe('EVENT_ALREADY_CLOSED');
    }
    expect(code(() => assertPoolChangeAllowed(ev('draft'), cmd))).toBeNull();
    expect(code(() => assertPoolChangeAllowed(ev('open'), cmd))).toBe('INVALID_STATE_TRANSITION');
  });

  it('a cancel reason needs 3 characters after trimming', () => {
    expect(requireReason('  تأجيل ')).toBe('تأجيل');
    for (const r of [undefined, null, '', '  ab  '])
      expect(code(() => requireReason(r))).toBe('REASON_REQUIRED');
  });
});
