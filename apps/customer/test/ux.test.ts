/// <reference types="node" />
/**
 * V2-UX (DEC-570 … DEC-579): the presentation logic of the redesign — the C-12 stage tracker and hero, the elapsed
 * time, the plate halves of `PlateBadge`, the C-06 subscription line and greeting, the C-08 yearly saving — and the
 * motion, shadow and status values read from brand/tokens (nothing invented).
 */
import { readFileSync } from 'node:fs';
import type { CustomerVisitDetail } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import {
  TRACKER_STAGES,
  bestYearlySaving,
  dayPart,
  elapsedView,
  formatElapsed,
  heroKind,
  homeSubscriptionLine,
  plateParts,
  trackerProgress,
  trackerStages,
} from '../src/features/ux';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { bezier, color, motion, ms, shadow, statusColor } from '../src/theme/tokens';

const tokens = JSON.parse(
  readFileSync(new URL('../../../brand/tokens/tokens.json', import.meta.url), 'utf8'),
) as {
  motion: Record<string, string>;
  shadow: { light: Record<string, string> };
  semantic: { dark: Record<string, { $value: string }> };
};

const T0 = Date.parse('2026-11-11T15:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

type Step = CustomerVisitDetail['timeline'][number]['step'];
function visit(
  status: CustomerVisitDetail['status'],
  reached: Partial<Record<Step, number>>,
  extra: Partial<Pick<CustomerVisitDetail, 'open' | 'request'>> = {},
) {
  const steps: Step[] = ['received', 'parked', 'requested', 'accepted', 'on_the_way', 'ready', 'delivered'];
  return {
    status,
    open: extra.open ?? status !== 'delivered',
    received_at: at(0),
    timeline: steps.map((step) => ({ step, at: reached[step] === undefined ? null : at(reached[step]) })),
    request: extra.request ?? { can_request: false, pending_early: false, requested_at: null },
  } satisfies Pick<CustomerVisitDetail, 'status' | 'open' | 'timeline' | 'request' | 'received_at'>;
}

const states = (v: Parameters<typeof trackerStages>[0]) => trackerStages(v).map((s) => s.state);

describe('C-12 stage tracker (DEC-570)', () => {
  it('has the six stages of 01 R3 in order', () => {
    expect(TRACKER_STAGES).toEqual(['received', 'parked', 'requested', 'on_the_way', 'ready', 'delivered']);
  });

  it('marks the stages done, current and to come from the status and the timeline', () => {
    expect(states(visit('parking', { received: 0 }))).toEqual([
      'done',
      'current',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(states(visit('parked', { received: 0, parked: 5 }))).toEqual([
      'done',
      'done',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(states(visit('requested', { received: 0, parked: 5, requested: 60 }))).toEqual([
      'done',
      'done',
      'current',
      'todo',
      'todo',
      'todo',
    ]);
    // «قُبل الطلب» belongs to the «إحضار» stage
    expect(states(visit('assigned', { received: 0, parked: 5, requested: 60, accepted: 61 }))).toEqual([
      'done',
      'done',
      'done',
      'current',
      'todo',
      'todo',
    ]);
    expect(
      states(
        visit('ready', { received: 0, parked: 5, requested: 60, accepted: 61, on_the_way: 62, ready: 64 }),
      ),
    ).toEqual(['done', 'done', 'done', 'done', 'current', 'todo']);
    expect(
      states(
        visit('delivered', {
          received: 0,
          parked: 5,
          requested: 60,
          accepted: 61,
          on_the_way: 62,
          ready: 64,
          delivered: 67,
        }),
      ),
    ).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });

  it('starts the retrieval stages over after a re-park', () => {
    expect(states(visit('reparking', { received: 0, parked: 5, requested: 60, accepted: 61 }))).toEqual([
      'done',
      'current',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
  });

  it('fills the rail up to the last reached stage', () => {
    expect(trackerProgress(trackerStages(visit('parked', { received: 0, parked: 5 })))).toBeCloseTo(0.2);
    expect(trackerProgress(trackerStages(visit('ready', { received: 0, parked: 5, ready: 64 })))).toBeCloseTo(
      0.8,
    );
    expect(trackerProgress([])).toBe(0);
  });

  it('names every stage apart from the timeline steps (no text twice on C-12)', () => {
    for (const d of [ar, en]) {
      const steps = new Set(Object.values(d.visit.steps));
      for (const stage of TRACKER_STAGES) {
        expect(d.visit.stages[stage]).toBeTruthy();
        expect(steps.has(d.visit.stages[stage])).toBe(false);
      }
    }
  });
});

describe('C-12 hero and elapsed time (DEC-570)', () => {
  it('pictures each ticket status', () => {
    expect(heroKind('parking')).toBe('parking');
    expect(heroKind('parked')).toBe('parked');
    expect(heroKind('requested')).toBe('waiting');
    expect(heroKind('retrieving')).toBe('moving');
    expect(heroKind('assigned_waiting')).toBe('moving');
    expect(heroKind('ready')).toBe('ready');
    expect(heroKind('delivered')).toBe('done');
    expect(heroKind('voided')).toBe('void');
  });

  it('formats the elapsed time as m:ss, then h:mm', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  it('counts from the request while the car is brought, never promises an arrival', () => {
    const v = visit(
      'retrieving',
      { received: 0, parked: 5, requested: 60 },
      { request: { can_request: false, pending_early: false, requested_at: at(60) } },
    );
    expect(elapsedView(v, ar, T0 + 62.5 * 60_000)).toEqual({
      label: ar.visit.since.requested,
      value: '2:30',
      live: true,
    });
  });

  it('shows the gate time when ready, the intake time while parked, nothing once delivered', () => {
    const ready = elapsedView(visit('ready', { received: 0, ready: 64 }), ar, T0);
    expect(ready).toMatchObject({ label: ar.visit.since.ready, live: false });
    expect(ready?.value).toMatch(/^\d{2}:\d{2}$/);
    expect(elapsedView(visit('parked', { received: 0, parked: 5 }), ar, T0)).toMatchObject({
      label: ar.visit.since.received,
      live: false,
    });
    expect(elapsedView(visit('delivered', { received: 0, delivered: 9 }), ar, T0)).toBeNull();
  });
});

describe('PlateBadge halves (DEC-578)', () => {
  it('splits a Saudi plate into its digits and letters', () => {
    expect(plateParts('4827 ر س ن')).toEqual({ digits: '4827', letters: 'ر س ن' });
    expect(plateParts('7 ا ب ح')).toEqual({ digits: '7', letters: 'ا ب ح' });
  });

  it('keeps any other plate whole', () => {
    expect(plateParts('ABC-123')).toBeNull();
    expect(plateParts('12345 ا ب ح')).toBeNull();
    expect(plateParts('1234 5678')).toBeNull();
  });
});

describe('C-06 and C-08 lines (DEC-576, DEC-577)', () => {
  const sub = {
    subscription_id: '00000000-0000-4000-8000-000000000001',
    venue_id: '00000000-0000-4000-8000-000000000002',
    venue_name_ar: 'برج',
    venue_name_en: null,
    billing_cycle: 'monthly' as const,
    current_period_end: '2026-12-11T09:00:00Z',
    cancel_at_period_end: false,
  };

  it('says when an active subscription renews or ends, else its status', () => {
    expect(homeSubscriptionLine({ ...sub, status: 'active' }, ar)).toMatch(
      /^يتجدد في 11\u00a0ديسمبر\u00a02026$/,
    );
    expect(homeSubscriptionLine({ ...sub, status: 'active', cancel_at_period_end: true }, ar)).toMatch(
      /^ينتهي في/,
    );
    expect(homeSubscriptionLine({ ...sub, status: 'past_due' }, ar)).toBe(ar.subscriptionStatus.past_due);
  });

  it('greets by the Riyadh time of day', () => {
    expect(dayPart(Date.parse('2026-11-11T05:00:00Z'))).toBe('morning'); // 08:00 Riyadh
    expect(dayPart(Date.parse('2026-11-11T15:00:00Z'))).toBe('evening'); // 18:00 Riyadh
    expect(dayPart(Date.parse('2026-11-11T22:00:00Z'))).toBe('evening'); // 01:00 Riyadh
  });

  it('picks the best yearly saving of a location', () => {
    expect(
      bestYearlySaving([
        { monthly_price_halalas: 34500, yearly_price_halalas: 345000 },
        { monthly_price_halalas: 23000, yearly_price_halalas: 220800 },
      ]),
    ).toBe(20);
    expect(bestYearlySaving([{ monthly_price_halalas: 34500, yearly_price_halalas: null }])).toBeNull();
  });
});

describe('redesign values come from brand/tokens (DEC-571, DEC-572)', () => {
  it('reads the motion durations and curves', () => {
    expect(motion.fast).toBe(ms(tokens.motion['duration-fast'] as string));
    expect(motion.base).toBe(200);
    expect(motion.slow).toBe(320);
    expect(motion.standard).toEqual(bezier(tokens.motion['ease-standard'] as string));
    expect(() => ms('2s')).toThrow();
    expect(() => bezier('ease-in')).toThrow();
  });

  it('uses the light shadows as they are', () => {
    expect(shadow).toEqual(tokens.shadow.light);
  });

  it('resolves the status colours and the text roles on the navy card', () => {
    expect(statusColor.ready).toEqual({ bg: '#05875C', fg: '#FFFFFF' });
    expect(statusColor.requested.bg).toBe('#FEEFC7');
    expect(color.textOnInverseMuted).toBe(tokens.semantic.dark['text-muted']?.$value);
    expect(color.surfaceInverse).toBe('#031435');
  });
});
