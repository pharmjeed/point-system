/**
 * V2-032: the subscriptions of the customer app — C-09's plans and choices (pure), C-14's cards (pure), the C-10
 * checkout of a subscription (start, 3-D Secure, the poll of the subscription's own read) on the in-app fake backend
 * that follows the server's rules (DEC-532, DEC-534), and the tapped subscription push.
 */
import type { CustomerLocationPlan, CustomerSubscription } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { FAKE_LOCATIONS } from '../src/api/fake/seed';
import { fakeTokenize } from '../src/api/fake/tokens';
import { checkoutSubscription, type SubscriptionCheckoutRequest } from '../src/features/pay/payFlow';
import { pushRoute } from '../src/features/push';
import {
  cyclesOf,
  planOptions,
  subscribeIssue,
  subscriptionCard,
  toggleVehicle,
  yearlySavingPct,
} from '../src/features/subscriptions';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { onboard, setup } from './helpers';

const OLAYA_PLAN = '0a7e9a52-1f0b-4a51-9c3e-2b6d8f1a0c01';
const card = (number: string) => ({ number, month: 12, year: 2030, cvc: '123', name: 'SARA' });
const CONSENT = '2026-11-01';

const plan = (over: Partial<CustomerLocationPlan> = {}): CustomerLocationPlan => ({
  ...FAKE_LOCATIONS[0]!.plans[0]!,
  plan_id: OLAYA_PLAN,
  name_ar: 'اشتراك سيارة واحدة',
  vehicles_included: 1,
  monthly_price_halalas: 34500,
  yearly_price_halalas: 345000,
  ...over,
});

describe('C-09 plans and choices (pure)', () => {
  it('the yearly saving against twelve months, the cycles sold, the plans of a cycle', () => {
    expect(yearlySavingPct(plan())).toBe(17); // 3450 against 4140
    expect(yearlySavingPct(plan({ yearly_price_halalas: 34500 * 12 }))).toBeNull();
    expect(yearlySavingPct(plan({ yearly_price_halalas: null }))).toBeNull();
    expect(cyclesOf([plan({ yearly_price_halalas: null })])).toEqual(['monthly']);
    expect(cyclesOf([plan(), plan({ monthly_price_halalas: null })])).toEqual(['monthly', 'yearly']);
    const monthly = planOptions([plan(), plan({ plan_id: 'x', monthly_price_halalas: null })], 'monthly', ar);
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({ planId: OLAYA_PLAN, price: 34500, saving: null });
    expect(monthly[0]!.priceText).toContain('345');
    expect(monthly[0]!.priceText).toContain('شهريًا');
    const yearly = planOptions([plan()], 'yearly', en);
    expect(yearly[0]).toMatchObject({ price: 345000, saving: 'Save 17%' });
    expect(yearly[0]!.priceText).toContain('a year');
  });

  it("the covered cars keep at most the plan's count (the oldest choice leaves), and the form is complete", () => {
    expect(toggleVehicle([], 'a', 1)).toEqual(['a']);
    expect(toggleVehicle(['a'], 'b', 1)).toEqual(['b']);
    expect(toggleVehicle(['a'], 'b', 2)).toEqual(['a', 'b']);
    expect(toggleVehicle(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
    expect(toggleVehicle(['a', 'b'], 'a', 2)).toEqual(['b']);
    expect(subscribeIssue(null, ['a'], ar)).toBe(ar.subscribe.choosePlan);
    expect(subscribeIssue('p', [], ar)).toBe(ar.subscribe.chooseVehicle);
    expect(subscribeIssue('p', ['a'], ar)).toBeNull();
  });
});

describe('C-14 cards (pure)', () => {
  const base: CustomerSubscription = {
    subscription_id: '11111111-1111-4111-8111-111111111111',
    venue_id: '22222222-2222-4222-8222-222222222222',
    venue_name_ar: 'برج العليا',
    venue_name_en: 'Olaya Tower',
    operator_name_ar: 'مصاف',
    operator_name_en: null,
    plan_id: OLAYA_PLAN,
    plan_name_ar: 'اشتراك سيارة واحدة',
    plan_name_en: null,
    billing_cycle: 'monthly',
    status: 'active',
    price_halalas: 34500,
    next_price_halalas: null,
    vehicles_included: 1,
    vehicles: [
      { vehicle_id: '33333333-3333-4333-8333-333333333333', plate_display: '4821 ب ح د', removed: false },
      { vehicle_id: '44444444-4444-4444-8444-444444444444', plate_display: '1 ا ا ا', removed: true },
    ],
    current_period_start: '2026-11-07T09:00:00.000Z',
    current_period_end: '2026-12-07T09:00:00.000Z',
    cancel_at_period_end: false,
    renews_at: '2026-12-07T09:00:00.000Z',
    pending_expires_at: null,
    grace_ends_at: null,
    frozen_at: null,
    frozen_reason: null,
    can_change_vehicles: true,
    can_cancel: true,
    can_resume: false,
    can_pay: false,
    latest_payment: null,
    ended_at: null,
    ended_reason: null,
    created_at: '2026-11-07T09:00:00.000Z',
    policy: FAKE_LOCATIONS[0]!.plans[0]!.policy,
    service_start_on: null,
    service_end_on: null,
    remaining_days: null,
    eligibility: null,
    freeze: null,
    freezes_left: 0,
    can_freeze: false,
    can_unfreeze: false,
    renew_plan_id: null,
    refund_due_at: null,
  };

  it('says the state and the one line that matters now', () => {
    const active = subscriptionCard(base, ar, 'ar');
    expect(active).toMatchObject({
      title: 'برج العليا',
      status: ar.subscriptionStatus.active,
      tone: 'success',
    });
    expect(active.line).toContain('يتجدد في');
    expect(active.price).toContain(ar.subscribe.monthly);
    expect(active.vehicles).toContain('4821 ب ح د');
    expect(active.vehicles).not.toContain('1 ا ا ا'); // a removed car is not covered any more
    expect(active.nextPrice).toBeNull();
    expect(subscriptionCard(base, en, 'en').title).toBe('Olaya Tower');

    const canceled = subscriptionCard({ ...base, cancel_at_period_end: true, renews_at: null }, ar, 'ar');
    expect(canceled.line).toContain('لن يتجدد');
    const pastDue = subscriptionCard(
      { ...base, status: 'past_due', renews_at: null, grace_ends_at: '2026-12-10T09:00:00.000Z' },
      ar,
      'ar',
    );
    expect(pastDue).toMatchObject({ tone: 'danger' });
    expect(pastDue.line).toContain('تعذّر التجديد');
    expect(subscriptionCard({ ...base, status: 'frozen' }, ar, 'ar').line).toBe(ar.subscriptions.frozen);
    const pending = subscriptionCard(
      { ...base, status: 'pending_payment', pending_expires_at: '2026-11-07T09:30:00.000Z' },
      ar,
      'ar',
    );
    expect(pending).toMatchObject({ tone: 'warning' });
    expect(pending.line).toContain('بانتظار الدفع');
    const ended = subscriptionCard(
      { ...base, status: 'expired', renews_at: null, ended_at: '2026-12-10T10:00:00.000Z' },
      ar,
      'ar',
    );
    expect(ended).toMatchObject({ tone: 'muted' });
    expect(ended.line).toContain('انتهى');
    expect(subscriptionCard({ ...base, next_price_halalas: 39000 }, ar, 'ar').nextPrice).toContain('390');
  });
});

describe('C-09 → C-10 → C-14 on the fake backend (V2-032)', () => {
  async function ready() {
    const ctx = setup();
    await onboard(ctx);
    const car = await ctx.api.addVehicle({ plate: { country: 'SA', digits: '4821', letters_ar: 'ب ح د' } });
    const opened: string[] = [];
    const deps = {
      api: ctx.api,
      openAuthSession: async (url: string) => {
        opened.push(url);
        ctx.clock.advance(1000);
      },
      sleep: async (ms: number) => ctx.clock.advance(ms),
      now: ctx.clock.now,
    };
    const subscribe =
      (cycle: 'monthly' | 'yearly' = 'monthly'): SubscriptionCheckoutRequest['start'] =>
      (body, key) =>
        ctx.api.subscribe({ plan_id: OLAYA_PLAN, billing_cycle: cycle, vehicle_ids: [car.id], ...body }, key);
    return { ctx, deps, opened, car, subscribe };
  }

  it('a new card kept for the renewals: paid at once → active, renewing at the end of the month', async () => {
    const { ctx, deps, subscribe } = await ready();
    const out = await checkoutSubscription(deps, {
      start: subscribe(),
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      saveCard: true,
      cardOnFileVersion: CONSENT,
      idempotencyKey: 'k-1',
    });
    expect(out.kind).toBe('paid');
    expect(out.subscriptionId).toBeTruthy();
    const [sub] = await ctx.api.subscriptions();
    expect(sub).toMatchObject({ status: 'active', price_halalas: 34500, can_cancel: true, can_pay: false });
    expect(sub!.renews_at).toBe('2026-12-07T09:00:00.000Z');
    expect(sub!.latest_payment?.receipt?.description).toBe('subscription');
    // the card is on file for the renewals
    expect(await ctx.api.paymentMethods()).toHaveLength(1);
    // the venue is «مشترك فيه» now
    const subscribed = await ctx.api.locations({ filter: 'subscribed' });
    expect(subscribed.items.map((l) => l.venue_id)).toEqual([sub!.venue_id]);
    // a second subscription at the same venue is refused
    const again = await checkoutSubscription(deps, {
      start: subscribe('yearly'),
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      saveCard: true,
      cardOnFileVersion: CONSENT,
      idempotencyKey: 'k-2',
    });
    expect(again).toMatchObject({ kind: 'exists', subscriptionId: sub!.subscription_id });
  });

  it('3-D Secure: the page opens, the return proves nothing, the poll of the subscription reads paid', async () => {
    const { ctx, deps, opened, subscribe } = await ready();
    const out = await checkoutSubscription(
      deps,
      {
        start: subscribe('yearly'),
        source: { type: 'token', token: fakeTokenize(card('4000000000000002')) },
        saveCard: true,
        cardOnFileVersion: CONSENT,
        idempotencyKey: 'k-3',
      },
      { pollMs: 500 },
    );
    expect(opened).toHaveLength(1);
    expect(out.kind).toBe('paid');
    const sub = await ctx.api.subscription(out.subscriptionId!);
    expect(sub).toMatchObject({ status: 'active', billing_cycle: 'yearly', price_halalas: 345000 });
  });

  it('a card not kept, Apple Pay, a declined card (the subscription waits, C-14 «ادفع» pays it)', async () => {
    const { ctx, deps, subscribe } = await ready();
    const notKept = await checkoutSubscription(deps, {
      start: subscribe(),
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      idempotencyKey: 'k-4',
    });
    expect(notKept.kind).toBe('card_required');
    const apple = await checkoutSubscription(deps, {
      start: subscribe(),
      source: { type: 'applepay', token: 'apple-token' },
      idempotencyKey: 'k-5',
    });
    expect(apple.kind).toBe('card_required');
    const declined = await checkoutSubscription(deps, {
      start: subscribe(),
      source: { type: 'token', token: fakeTokenize(card('4201320000311101')) },
      saveCard: true,
      cardOnFileVersion: CONSENT,
      idempotencyKey: 'k-6',
    });
    expect(declined).toMatchObject({ kind: 'failed', code: '51' });
    expect(declined.subscriptionId).toBeTruthy();
    const waiting = await ctx.api.subscription(declined.subscriptionId!);
    expect(waiting).toMatchObject({ status: 'pending_payment', can_pay: true, can_cancel: true });
    const paid = await checkoutSubscription(deps, {
      start: (body, key) => ctx.api.paySubscription(waiting.subscription_id, body, key),
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      saveCard: true,
      cardOnFileVersion: CONSENT,
      idempotencyKey: 'k-7',
    });
    expect(paid.kind).toBe('paid');
    expect((await ctx.api.subscription(waiting.subscription_id)).status).toBe('active');
  });

  it('a waiting subscription lapses after 30 minutes; «إلغاء الطلب» ends it at once', async () => {
    const { ctx, deps, subscribe } = await ready();
    const declined = await checkoutSubscription(deps, {
      start: subscribe(),
      source: { type: 'token', token: fakeTokenize(card('4201320000311101')) },
      saveCard: true,
      cardOnFileVersion: CONSENT,
      idempotencyKey: 'k-8',
    });
    ctx.clock.advance(31 * 60_000);
    expect(await ctx.api.subscription(declined.subscriptionId!)).toMatchObject({
      status: 'canceled',
      ended_reason: 'pending_expired',
      can_pay: false,
    });
    const again = await checkoutSubscription(deps, {
      start: subscribe(),
      source: { type: 'token', token: fakeTokenize(card('4201320000311101')) },
      saveCard: true,
      cardOnFileVersion: CONSENT,
      idempotencyKey: 'k-9',
    });
    const abandoned = await ctx.api.cancelSubscription(again.subscriptionId!, 'k-10');
    expect(abandoned).toMatchObject({ status: 'canceled', ended_reason: 'abandoned' });
  });

  it('cancel at the end of the period, resume, and the covered car changed once per period', async () => {
    const { ctx, deps, subscribe, car } = await ready();
    const out = await checkoutSubscription(deps, {
      start: subscribe(),
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      saveCard: true,
      cardOnFileVersion: CONSENT,
      idempotencyKey: 'k-11',
    });
    const id = out.subscriptionId!;
    const canceled = await ctx.api.cancelSubscription(id, 'k-12');
    expect(canceled).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      can_resume: true,
      renews_at: null,
    });
    const resumed = await ctx.api.resumeSubscription(id, 'k-13');
    expect(resumed).toMatchObject({ cancel_at_period_end: false, can_resume: false });
    expect(resumed.renews_at).not.toBeNull();

    const other = await ctx.api.addVehicle({ plate: { country: 'SA', digits: '7', letters_ar: 'ا ب ح' } });
    const changed = await ctx.api.setSubscriptionVehicles(id, [other.id], 'k-14');
    expect(changed.vehicles.map((v) => v.vehicle_id)).toEqual([other.id]);
    expect(changed.can_change_vehicles).toBe(false);
    await expect(ctx.api.setSubscriptionVehicles(id, [car.id], 'k-15')).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.code === 'SUBSCRIPTION_VEHICLES_LOCKED',
    );

    // canceled at the end of the period: it ends there
    await ctx.api.cancelSubscription(id, 'k-16');
    ctx.clock.advance(31 * 24 * 3600_000);
    expect(await ctx.api.subscription(id)).toMatchObject({ status: 'canceled', ended_reason: 'period_end' });
  });
});

describe('a tapped subscription push (V2-031)', () => {
  it('opens C-14', () => {
    const subscriptionId = '11111111-1111-4111-8111-111111111111';
    expect(
      pushRoute({ type: 'subscription', kind: 'subscription_renewal', subscription_id: subscriptionId }),
    ).toEqual({
      pathname: '/subscriptions',
      params: { subscriptionId },
    });
    expect(pushRoute({ type: 'subscription', kind: 'nope', subscription_id: subscriptionId })).toBeNull();
  });
});
