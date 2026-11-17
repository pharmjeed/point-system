/**
 * V2-036 / V2-037 (docs/v2/04 §7; DEC-590 … DEC-605): the subscriptions annex in the app — C-09's plan details (net,
 * VAT, total, the counted days and their dates, the policies, the consent), the eligibility application, the payment
 * with the purchase consent, C-14's counted-day lines, the freeze sheet's choices and preview, and the complaints with
 * a reference — on the in-app fake backend that follows the server's rules. The clock starts on Saturday 2026-11-07
 * 12:00 Riyadh.
 */
import { SUBSCRIPTION_TERMS_VERSION } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { FAKE_LOCATIONS, FAKE_STUDENT_PLAN_ID, FAKE_UNIVERSITY_ID } from '../src/api/fake/seed';
import { fakeTokenize } from '../src/api/fake/tokens';
import { checkoutSubscription } from '../src/features/pay/payFlow';
import {
  applicationIssue,
  closureLines,
  complaintCard,
  consentRequired,
  dayText,
  freezeDayChoices,
  freezePreview,
  planAnnex,
  subscriptionAnnex,
} from '../src/features/annex';
import { ar } from '../src/i18n/ar';
import { onboard, setup } from './helpers';

const card = { number: '4111111111111111', month: 12, year: 2030, cvc: '123', name: 'SARA' };
const studentPlan = () =>
  FAKE_LOCATIONS.find((l) => l.venue_id === FAKE_UNIVERSITY_ID)!.plans.find(
    (p) => p.plan_id === FAKE_STUDENT_PLAN_ID,
  )!;
const consent = {
  terms_version: SUBSCRIPTION_TERMS_VERSION,
  privacy_version: '2026-11-01',
  non_refundable: true,
  valuables_notice: true,
};

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('C-09 plan details (pure)', () => {
  it('the student plan: audience, 22 counted days Sunday … Thursday, 150 + 22.50 VAT = 172.50, its policies', () => {
    const a = planAnnex(
      { ...studentPlan(), term_preview: { starts_on: '2026-11-08', ends_on: '2026-12-07' } },
      ar,
    );
    expect(a.audience).toContain('طلاب وطالبات الجامعة');
    expect(a.term).toContain('22');
    expect(a.term).toContain('الأحد');
    expect(a.term).toContain('الخميس');
    expect(a.breakdown?.net).toContain('150.00');
    expect(a.breakdown?.vat).toContain('22.50');
    expect(a.breakdown?.total).toContain('172.50');
    expect(a.preview).toBe('إن دفعت اليوم: 8\u00a0نوفمبر – 7\u00a0ديسمبر\u00a02026');
    expect(a).toMatchObject({
      needsEligibility: true,
      needsConsent: true,
      nonRefundable: true,
      manualRenewal: true,
    });
    expect(a.bullets.map((b) => b.text)).toEqual(
      expect.arrayContaining([ar.annex.policy.daily, ar.annex.policy.nonRefundable, ar.annex.policy.manual]),
    );
    // a V4 plan keeps its V4 terms: no consent required, no counted days
    const v4 = planAnnex(FAKE_LOCATIONS[0]!.plans[0]!, ar);
    expect(v4).toMatchObject({ term: null, needsConsent: false, needsEligibility: false, bullets: [] });
    expect(consentRequired(FAKE_LOCATIONS[0]!.plans[0]!.policy)).toBe(false);
  });

  it('dates read with their weekday; closures one line each; the application form', () => {
    expect(dayText('2026-11-08', ar)).toContain('الأحد');
    const lines = closureLines(
      [
        {
          closure_id: 'x',
          kind: 'holiday',
          starts_on: '2026-12-27',
          ends_on: '2027-01-07',
          reason_ar: 'إجازة',
        },
      ],
      ar,
    );
    expect(lines[0]).toContain('إجازة');
    expect(applicationIssue('a', 'سارة', ar)).toBe(ar.annex.numberInvalid);
    expect(applicationIssue('441234567', ' ', ar)).toBe(ar.annex.nameInvalid);
    expect(applicationIssue('441234567', 'سارة', ar)).toBeNull();
  });

  it('the freeze sheet offers service days only and previews the counted days and the new end', () => {
    expect(freezeDayChoices('2026-11-12', [0, 1, 2, 3, 4], 3)).toEqual([
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
    const sub = {
      policy: studentPlan().policy,
      service_start_on: '2026-11-08',
      service_end_on: '2026-12-07',
    } as Parameters<typeof freezePreview>[0];
    expect(freezePreview(sub, '2026-11-16', '2026-11-23', '2026-11-12', ar)).toMatchObject({
      ok: true,
      days: 5,
      newEnd: '2026-12-14',
    });
    expect(freezePreview(sub, '2026-11-16', '2026-11-24', '2026-11-12', ar)).toMatchObject({ ok: false });
    expect(freezePreview(sub, '2026-11-12', '2026-11-15', '2026-11-12', ar).issue).toBe(
      ar.annex.freezeIssues.not_in_advance,
    );
  });
});

describe('the annex on the fake backend', () => {
  async function ready() {
    const ctx = setup();
    await onboard(ctx);
    const v = await ctx.api.addVehicle({ plate: { country: 'SA', digits: '4821', letters_ar: 'ب ح د' } });
    return { ctx, vehicleId: v.id };
  }

  it('apply → pending → approved → paid with the consent → 22 counted days → freeze → complaint', async () => {
    const { ctx, vehicleId } = await ready();
    const loc = await ctx.api.location(FAKE_UNIVERSITY_ID);
    const plan = loc.plans[0]!;
    // Saturday 12:00: paid now, day 1 is Sunday
    expect(plan.term_preview).toEqual({ starts_on: '2026-11-08', ends_on: '2026-12-07' });
    expect(loc.closures).toHaveLength(1);
    const direct = await rejection(
      ctx.api.subscribe({
        plan_id: plan.plan_id,
        billing_cycle: 'monthly',
        vehicle_ids: [vehicleId],
        source: { type: 'token', token: fakeTokenize(card) },
        purchase_consent: consent,
      }),
    );
    expect(direct.code).toBe('SUBSCRIPTION_ELIGIBILITY_REQUIRED');
    const applied = await ctx.api.applySubscription({
      plan_id: plan.plan_id,
      vehicle_ids: [vehicleId],
      student_number: '441234567',
      student_name: 'سارة',
    });
    expect(applied).toMatchObject({
      status: 'pending_eligibility',
      can_pay: false,
      eligibility: { status: 'pending', student_number_masked: '••••••567' },
    });
    expect(subscriptionAnnex(applied, ar).lines[0]).toContain('567');
    ctx.clock.advance(6000);
    const approved = await ctx.api.subscription(applied.subscription_id);
    expect(approved).toMatchObject({ status: 'pending_payment', can_pay: true });
    const noConsent = await rejection(
      ctx.api.paySubscription(approved.subscription_id, {
        source: { type: 'token', token: fakeTokenize(card) },
      }),
    );
    expect(noConsent.code).toBe('CUSTOMER_CONSENT_REQUIRED');
    // DEC-619: terms changed since C-09 was read → the sheet says so (not the saved-card consent)
    const stale = await checkoutSubscription(
      { api: ctx.api, openAuthSession: async () => undefined, sleep: async () => undefined, now: () => 0 },
      {
        start: (body, key) =>
          ctx.api.paySubscription(
            approved.subscription_id,
            { ...body, purchase_consent: { ...consent, terms_version: '2020-01-01' } },
            key,
          ),
        source: { type: 'token', token: fakeTokenize(card) },
        idempotencyKey: 'stale-terms',
      },
    );
    expect(stale).toEqual({ kind: 'terms_stale' });
    // a plan renewed by hand: a card that is not kept pays it
    const paid = await ctx.api.paySubscription(approved.subscription_id, {
      source: { type: 'token', token: fakeTokenize(card) },
      purchase_consent: consent,
    });
    expect(paid.payment.status).toBe('paid');
    expect(await ctx.api.paymentMethods()).toHaveLength(0);
    const active = await ctx.api.subscription(approved.subscription_id);
    expect(active).toMatchObject({
      status: 'active',
      service_start_on: '2026-11-08',
      service_end_on: '2026-12-07',
      remaining_days: 22,
      can_cancel: false,
      can_freeze: true,
    });
    // one compact range, the days left with their Arabic form, the policy note (DEC-612)
    expect(subscriptionAnnex(active, ar)).toMatchObject({
      lines: [],
      period: '8\u00a0نوفمبر – 7\u00a0ديسمبر\u00a02026',
      remaining: 'متبقٍ 22 يومًا من 22',
      progress: 0,
      freezeLines: [],
      policyNote: 'غير قابل للاسترداد · التجديد بطلبك',
    });
    // the freeze: Monday → Monday, 5 counted days, the end moves a week
    const frozen = await ctx.api.freezeSubscription(active.subscription_id, {
      starts_on: '2026-11-09',
      returns_on: '2026-11-16',
    });
    expect(frozen.freeze).toMatchObject({ status: 'scheduled', days: 5, projected_end_on: '2026-12-14' });
    ctx.clock.advance(3 * 86_400_000); // Tuesday 11-10: running
    expect(await ctx.api.subscription(active.subscription_id)).toMatchObject({
      status: 'frozen',
      can_unfreeze: true,
    });
    const back = await ctx.api.unfreezeSubscription(active.subscription_id);
    // reactivated Tuesday: Monday frozen only
    expect(back).toMatchObject({ status: 'active', service_end_on: '2026-12-08', freeze: { used_days: 1 } });
    expect(back.can_freeze).toBe(false);
    // a complaint gets its reference at once
    const c = await ctx.api.createComplaint({
      category: 'subscription',
      body: 'لم يُقبل الاشتراك عند البوابة صباح اليوم',
      subscription_id: active.subscription_id,
    });
    expect(c.reference).toMatch(/^PT-C-\d{6}$/);
    expect(complaintCard(c, ar)).toMatchObject({ status: ar.annex.complaintStatus.open });
    expect((await ctx.api.complaints()).map((x) => x.reference)).toEqual([c.reference]);
  });

  it('a student number ending with 9 is rejected by the fake review', async () => {
    const { ctx, vehicleId } = await ready();
    const applied = await ctx.api.applySubscription({
      plan_id: FAKE_STUDENT_PLAN_ID,
      vehicle_ids: [vehicleId],
      student_number: '441234569',
      student_name: 'سارة',
    });
    ctx.clock.advance(6000);
    const s = await ctx.api.subscription(applied.subscription_id);
    expect(s).toMatchObject({ status: 'canceled', ended_reason: 'eligibility_rejected' });
    expect(subscriptionAnnex(s, ar).lines.join(' ')).toContain('الرقم غير مسجل');
  });
});
