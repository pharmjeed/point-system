/**
 * V2-UX option A «زر واحد» (DEC-620 … DEC-628): the hold-to-request state machine (progress, countdown, early release,
 * completion firing once, the dialog path, the reduce-motion plan), the circle's stage, colour and action for every
 * ticket status, its copy in both languages, and «اطلب السيارة» as one command for C-06 and C-12 (`requestCar`)
 * through the client and the fake backend — one request however often it is held, the same key kept after a
 * network error.
 */
import { TICKET_STATUSES } from '@point/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NetworkError, type Transport } from '../src/api/transport';
import { CommandKey } from '../src/features/commandKey';
import {
  HOLD_MS,
  HOLD_STEPS,
  holdCount,
  holdMotion,
  holdProgress,
  holdReducer,
  initialHold,
  type HoldEvent,
  type HoldState,
} from '../src/features/hold';
import { codeGroups, homeAction, homeStage, homeStop, homeTone } from '../src/features/home';
import { requestCar } from '../src/features/requestCar';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { onboard, setup } from './helpers';

const DEMO = '+966500000099';
const DEMO_TICKET = '3c9d6e2a-7b1f-4c8d-9e0a-1b2c3d4e5f60';

const run = (events: HoldEvent[], from: HoldState = initialHold) => events.reduce(holdReducer, from);

describe('hold to request (DEC-621)', () => {
  it('lasts three seconds, counting 3 · 2 · 1', () => {
    expect(HOLD_MS).toBe(3000);
    expect(HOLD_STEPS).toBe(3);
    expect(holdCount(0)).toBe(3);
    expect(holdCount(0.33)).toBe(3);
    expect(holdCount(1 / 3)).toBe(2);
    expect(holdCount(0.5)).toBe(2);
    expect(holdCount(0.7)).toBe(1);
    expect(holdCount(0.999)).toBe(1);
  });

  it('fills the ring with the time held, from the press', () => {
    const held = run([{ type: 'press', at: 1000 }]);
    expect(held.phase).toBe('holding');
    expect(holdProgress(held, 1000)).toBe(0);
    expect(holdProgress(held, 2500)).toBeCloseTo(0.5);
    expect(holdProgress(held, 9000)).toBe(1);
    expect(holdProgress(initialHold, 2500)).toBe(0);
    // a tick that changes nothing visible keeps the same state (no render)
    expect(holdReducer(held, { type: 'tick', at: 1200 })).toBe(held);
    expect(holdReducer(held, { type: 'tick', at: 2100 }).count).toBe(2);
    expect(holdReducer(held, { type: 'tick', at: 3100 }).count).toBe(1);
  });

  it('requests nothing when let go before three seconds, and shows the hint', () => {
    const early = run([
      { type: 'press', at: 0 },
      { type: 'tick', at: 1000 },
      { type: 'tick', at: 2900 },
      { type: 'release', at: 2950 },
    ]);
    expect(early).toMatchObject({ phase: 'idle', fired: 0, hint: true, count: 3, startedAt: null });
    // a tap (a press and an immediate release) is a short hold too
    expect(
      run([
        { type: 'press', at: 0 },
        { type: 'release', at: 80 },
      ]),
    ).toMatchObject({ fired: 0, hint: true });
    // the system took the touch away (the finger slid off, a scroll): nothing, and no hint
    expect(run([{ type: 'press', at: 0 }, { type: 'cancel' }])).toMatchObject({
      phase: 'idle',
      fired: 0,
      hint: false,
    });
    // the next press, or a few seconds, hide the hint
    expect(holdReducer(early, { type: 'press', at: 5000 }).hint).toBe(false);
    expect(holdReducer(early, { type: 'hideHint' }).hint).toBe(false);
  });

  it('fires exactly once at three seconds, whatever follows', () => {
    const done = run([
      { type: 'press', at: 0 },
      { type: 'tick', at: 1000 },
      { type: 'tick', at: 3000 },
    ]);
    expect(done).toMatchObject({ phase: 'sending', fired: 1, count: 0 });
    const after = run(
      [
        { type: 'tick', at: 3050 },
        { type: 'tick', at: 4000 },
        { type: 'release', at: 4100 },
        { type: 'press', at: 4200 },
        { type: 'confirm' },
        { type: 'cancel' },
      ],
      done,
    );
    expect(after).toMatchObject({ phase: 'sending', fired: 1 });
    // the server answered: back at rest (the screen has usually moved on by then)
    const settled = holdReducer(after, { type: 'settled' });
    expect(settled).toMatchObject({ phase: 'idle', fired: 1, hint: false });
    expect(holdReducer(settled, { type: 'settled' })).toBe(settled);
    // another full hold is another command (the server's idempotency and «طلبت سيارتك مسبقًا» take it from there)
    expect(
      run(
        [
          { type: 'press', at: 10_000 },
          { type: 'tick', at: 13_000 },
        ],
        settled,
      ).fired,
    ).toBe(2);
  });

  it('completes on a late release when no tick saw the end', () => {
    expect(
      run([
        { type: 'press', at: 0 },
        { type: 'release', at: 3001 },
      ]),
    ).toMatchObject({ phase: 'sending', fired: 1, hint: false });
  });

  it('takes the confirmation dialog of screen readers and the keyboard as one completed hold', () => {
    const confirmed = run([{ type: 'confirm' }]);
    expect(confirmed).toMatchObject({ phase: 'sending', fired: 1 });
    expect(holdReducer(confirmed, { type: 'confirm' })).toBe(confirmed);
    // a release or a tick without a press does nothing
    expect(holdReducer(initialHold, { type: 'release', at: 10 })).toBe(initialHold);
    expect(holdReducer(initialHold, { type: 'tick', at: 10 })).toBe(initialHold);
  });

  it('under reduce motion keeps only the linear ring: no light, rings, glow, burst or scale, and snaps', () => {
    const calm = holdMotion(true);
    expect(calm).toMatchObject({
      comet: false,
      glow: false,
      pulses: false,
      burst: false,
      pressScale: 1,
      swapMs: 0,
    });
    expect(calm.unwindMs(0.9)).toBe(0);
    const lively = holdMotion(false);
    expect(lively).toMatchObject({ comet: true, glow: true, pulses: true, burst: true });
    expect(lively.pressScale).toBeLessThan(1);
    expect(lively.unwindMs(0)).toBeLessThan(lively.unwindMs(1));
    expect(lively.unwindMs(1)).toBeLessThanOrEqual(400);
    // the ring fills linearly over the hold in both (the circle animates it whatever the setting)
    const source = readFileSync(new URL('../src/ui/HoldCircle.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/duration: HOLD_MS, easing: Easing\.linear/);
  });

  it('has its copy in both languages; the dialog keeps the confirmation copy', () => {
    for (const d of [ar, en]) {
      for (const k of ['hold', 'holdCaption', 'holding', 'holdHint'] as const) expect(d.home[k]).toBeTruthy();
      expect(d.visit.holdHint).toBeTruthy();
      expect(d.visit.holdCaption).toBeTruthy();
      expect(d.visit.requestConfirmTitle).toBeTruthy();
    }
    expect(ar.visit.holdHint).toBe('اضغط مطولًا ثلاث ثوانٍ، أو انقر مرتين للتأكيد');
    expect(ar.home.holdHint).toBe('اضغط مطولًا 3 ثوانٍ لطلب سيارتك');
    // Western digits only (CLAUDE.md §3.10)
    expect(JSON.stringify(ar.home)).not.toMatch(/[٠-٩]/);
  });
});

describe('C-06 circle: stage, colour and action (DEC-581, DEC-620)', () => {
  it('maps every ticket status onto a stop and a colour', () => {
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
    expect(homeTone('none')).toBe('blue');
    expect(homeTone('parked')).toBe('blue');
    expect(homeTone('requested')).toBe('navy');
    expect(homeTone('coming')).toBe('navy');
    expect(homeTone('ready')).toBe('green');
  });

  it('has a status line for every stage in both languages', () => {
    const stages = [
      'none',
      'parking',
      'reparking',
      'parked',
      'early',
      'requested',
      'coming',
      'ready',
    ] as const;
    for (const d of [ar, en]) for (const stage of stages) expect(d.home.status[stage]).toBeTruthy();
    expect(ar.home.status.none).toBe('عند وصولك');
    expect(ar.home.status.parked).toBe('سيارتك متوقفة بأمان');
    expect(ar.home.status.coming).toBe('في الطريق إليك');
    expect(ar.home.status.ready).toBe('جاهزة عند البوابة');
  });

  it('gives the circle one action for the moment', () => {
    const detail = (canRequest: boolean, requestedAt: string | null, code: boolean) => ({
      request: { can_request: canRequest, requested_at: requestedAt },
      handover: { code_available: code },
    });
    expect(homeAction('none', null)).toBe('pass');
    expect(homeAction('parked', null)).toBe('open');
    expect(homeAction('parked', detail(true, null, false))).toBe('hold');
    expect(homeAction('parked', detail(false, null, false))).toBe('open');
    expect(homeAction('parking', detail(true, null, false))).toBe('hold');
    expect(homeAction('requested', detail(false, '2026-11-17T10:00:00Z', false))).toBe('elapsed');
    expect(homeAction('coming', detail(false, null, false))).toBe('open');
    expect(homeAction('ready', detail(false, '2026-11-17T10:00:00Z', true))).toBe('code');
    expect(homeAction('ready', detail(false, '2026-11-17T10:00:00Z', false))).toBe('open');
  });

  it('writes the handover code in two groups of three', () => {
    expect(codeGroups('481927')).toBe('481 927');
    expect(codeGroups('12AB')).toBe('12AB');
  });
});

describe('«اطلب السيارة» — one command for C-06 and C-12 (DEC-581, DEC-622)', () => {
  it('requests once: a second hold with the same screen gets «طلبت سيارتك مسبقًا», not a second request', async () => {
    const ctx = setup({ demoVisitPhones: [DEMO] });
    await onboard(ctx, DEMO);
    let n = 0;
    const key = new CommandKey(() => `hold-${++n}`);
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
    const key = new CommandKey(() => `hold-${++n}`);
    expect(await requestCar(ctx.api, DEMO_TICKET, key, ar)).toEqual({
      kind: 'offline',
      text: ar.visit.offline,
    });
    offline = false;
    expect((await requestCar(ctx.api, DEMO_TICKET, key, ar)).kind).toBe('requested');
    expect(keys).toEqual(['hold-1', 'hold-1']);
  });
});
