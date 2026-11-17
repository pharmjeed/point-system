/**
 * V2-UX option B «البطاقة الحية» (DEC-580 … DEC-584): the swipe-to-request arithmetic (threshold, direction, reset),
 * the hero's stage and stop for every ticket status, the live card's action, and «اطلب السيارة» as one command for
 * C-06 and C-12 (`requestCar`) through the client and the fake backend — one request however often it is swiped, the
 * same key kept after a network error.
 */
import { TICKET_STATUSES } from '@point/shared';
import { describe, expect, it } from 'vitest';
import { NetworkError, type Transport } from '../src/api/transport';
import { CommandKey } from '../src/features/commandKey';
import { HOME_STOPS, homeAction, homeStage, homeStop } from '../src/features/home';
import { requestCar } from '../src/features/requestCar';
import {
  SWIPE_CONFIRM_AT,
  isHorizontalDrag,
  swipeLabelOpacity,
  swipeOffset,
  swipeOutcome,
  swipeTranslate,
  swipeTravel,
} from '../src/features/swipe';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { onboard, setup } from './helpers';

const DEMO = '+966500000099';
const DEMO_TICKET = '3c9d6e2a-7b1f-4c8d-9e0a-1b2c3d4e5f60';

describe('swipe to request (DEC-583)', () => {
  const travel = swipeTravel({ track: 296, knob: 48, inset: 4 });

  it('measures the travel of the knob inside its track', () => {
    expect(travel).toBe(240);
    expect(swipeTravel({ track: 0, knob: 48, inset: 4 })).toBe(0);
  });

  it('moves forward to the left in Arabic and to the right in English, clamped to the track', () => {
    expect(swipeOffset(-100, travel, true)).toBe(100);
    expect(swipeOffset(100, travel, true)).toBe(0); // backwards past the start stays at the start
    expect(swipeOffset(-999, travel, true)).toBe(travel);
    expect(swipeOffset(100, travel, false)).toBe(100);
    expect(swipeOffset(-100, travel, false)).toBe(0);
    expect(swipeTranslate(100, true)).toBe(-100);
    expect(swipeTranslate(100, false)).toBe(100);
  });

  it('confirms only past 85 % of the way; anything shorter springs back', () => {
    expect(SWIPE_CONFIRM_AT).toBe(0.85);
    expect(swipeOutcome(travel, travel)).toBe('confirm');
    expect(swipeOutcome(travel * 0.85, travel)).toBe('confirm');
    expect(swipeOutcome(travel * 0.84, travel)).toBe('reset');
    expect(swipeOutcome(travel * 0.5, travel)).toBe('reset');
    expect(swipeOutcome(0, travel)).toBe('reset');
    // a tap (no movement) and a track not measured yet never request
    expect(swipeOutcome(swipeOffset(0, travel, true), travel)).toBe('reset');
    expect(swipeOutcome(0, 0)).toBe('reset');
  });

  it('fades the label as the knob moves and takes only horizontal drags', () => {
    expect(swipeLabelOpacity(0, travel)).toBe(1);
    expect(swipeLabelOpacity(travel * 0.3, travel)).toBeCloseTo(0.5);
    expect(swipeLabelOpacity(travel, travel)).toBe(0);
    expect(swipeLabelOpacity(10, 0)).toBe(1);
    expect(isHorizontalDrag(20, 5)).toBe(true);
    expect(isHorizontalDrag(5, 20)).toBe(false);
    expect(isHorizontalDrag(3, 0)).toBe(false);
  });

  it('has its copy in both languages; the screen-reader dialog keeps the old confirmation copy', () => {
    for (const d of [ar, en]) {
      expect(d.visit.swipe).toBeTruthy();
      expect(d.visit.swipeHint).toBeTruthy();
      expect(d.visit.requestConfirmTitle).toBeTruthy();
    }
    expect(ar.visit.swipe).toBe('اسحب لطلب السيارة');
    expect(ar.visit.swipeHint).toBe('اسحب أو انقر مرتين للتأكيد');
  });
});

describe('C-06 hero stages and stops (DEC-581)', () => {
  it('maps every ticket status onto the three stops', () => {
    const map = Object.fromEntries(TICKET_STATUSES.map((s) => [s, homeStop(homeStage(s))]));
    expect(map).toEqual({
      received: 0,
      parking: 0,
      parked: 0,
      reparking: 0,
      requested: 1,
      assigned: 1,
      assigned_waiting: 1,
      retrieving: 1,
      ready: 2,
      delivered: null,
      voided: null,
    });
    expect(homeStage(null)).toBe('none');
    expect(homeStage('parking', true)).toBe('early');
    expect(homeStop('early')).toBe(1);
    expect(HOME_STOPS).toEqual(['parked', 'coming', 'ready']);
  });

  it('has a title and a line for every stage, and a name for every stop, in both languages', () => {
    for (const d of [ar, en]) {
      for (const stage of [
        'none',
        'parking',
        'reparking',
        'parked',
        'early',
        'requested',
        'coming',
        'ready',
      ] as const) {
        expect(d.home.hero[stage].title).toBeTruthy();
        expect(d.home.hero[stage].body).toBeTruthy();
      }
      for (const s of HOME_STOPS) expect(d.home.stops[s]).toBeTruthy();
    }
    // the brand only through `{brand}` (CLAUDE.md §3.11)
    expect(ar.home.hero.none.title).toContain('{brand}');
  });

  it('gives the live card one action for the moment', () => {
    const detail = (canRequest: boolean, requestedAt: string | null, code: boolean) => ({
      request: { can_request: canRequest, requested_at: requestedAt },
      handover: { code_available: code },
    });
    expect(homeAction('none', null)).toBe('pass');
    expect(homeAction('parked', null)).toBe('open');
    expect(homeAction('parked', detail(true, null, false))).toBe('swipe');
    expect(homeAction('parked', detail(false, null, false))).toBe('open');
    expect(homeAction('parking', detail(true, null, false))).toBe('swipe');
    expect(homeAction('requested', detail(false, '2026-11-17T10:00:00Z', false))).toBe('elapsed');
    expect(homeAction('coming', detail(false, null, false))).toBe('open');
    expect(homeAction('ready', detail(false, '2026-11-17T10:00:00Z', true))).toBe('code');
    expect(homeAction('ready', detail(false, '2026-11-17T10:00:00Z', false))).toBe('open');
  });
});

describe('«اطلب السيارة» — one command for C-06 and C-12 (DEC-581, DEC-584)', () => {
  it('requests once: a second swipe with the same screen gets «طلبت سيارتك مسبقًا», not a second request', async () => {
    const ctx = setup({ demoVisitPhones: [DEMO] });
    await onboard(ctx, DEMO);
    let n = 0;
    const key = new CommandKey(() => `swipe-${++n}`);
    const first = await requestCar(ctx.api, DEMO_TICKET, key, ar);
    expect(first).toMatchObject({
      kind: 'requested',
      text: ar.visit.requested,
      visit: { status: 'requested' },
    });
    const again = await requestCar(ctx.api, DEMO_TICKET, key, ar);
    expect(again).toEqual({ kind: 'already', text: ar.visit.alreadyRequested });
    expect((await ctx.api.visit(DEMO_TICKET)).status).toBe('requested');
  });

  it('keeps the same Idempotency-Key after a network error, so the retry cannot ask twice', async () => {
    const keys: (string | undefined)[] = [];
    let offline = true;
    const ctx = setup({
      demoVisitPhones: [DEMO],
      transport: (t: Transport) => async (req) => {
        if (req.path.endsWith('/request')) {
          keys.push(req.headers['Idempotency-Key']);
          if (offline) throw new NetworkError('offline');
        }
        return t(req);
      },
    });
    await onboard(ctx, DEMO);
    let n = 0;
    const key = new CommandKey(() => `swipe-${++n}`);
    expect(await requestCar(ctx.api, DEMO_TICKET, key, ar)).toEqual({
      kind: 'offline',
      text: ar.visit.offline,
    });
    offline = false;
    expect((await requestCar(ctx.api, DEMO_TICKET, key, ar)).kind).toBe('requested');
    expect(keys).toEqual(['swipe-1', 'swipe-1']);
  });
});
