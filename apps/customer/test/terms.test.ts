/**
 * C-24 «الشروط والأحكام» (DEC-614 … DEC-618): the versioned terms of the app — one version everywhere (the app's
 * text, the server's default `CUSTOMER_SUBSCRIPTION_TERMS_VERSION` through `@point/shared`, the fake backend), the
 * Arabic and English documents clause for clause, every annex clause present, the plan's own values when opened from a
 * plan, and `docs/v2/store/TERMS_AR.md` / `TERMS_EN.md` identical to the app's text (`TERMS_DOCS_WRITE=1` rewrites
 * them). Also the counted words of DEC-611 and the C-09 / C-14 copy built on them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CUSTOMER_APP_BRAND_DEFAULTS } from '@point/shared';
import { SUBSCRIPTION_TERMS_VERSION } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import {
  FAKE_LOCATIONS,
  FAKE_STUDENT_PLAN_ID,
  FAKE_SUBSCRIPTION_TERMS_VERSION,
  FAKE_UNIVERSITY_ID,
} from '../src/api/fake/seed';
import { planAnnex, rangeText } from '../src/features/annex';
import { planTermsValues, termsView } from '../src/features/terms';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { countText } from '../src/i18n/format';
import { renderTerms, termsMarkdown, TERMS_TOKENS, type TermsDocument } from '../src/legal/terms';
import { termsAr } from '../src/legal/terms.ar';
import { termsEn } from '../src/legal/terms.en';

const BRAND_AR = CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_AR;
const BRAND_EN = CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_EN;
const studentPlan = () =>
  FAKE_LOCATIONS.find((l) => l.venue_id === FAKE_UNIVERSITY_ID)!.plans.find(
    (p) => p.plan_id === FAKE_STUDENT_PLAN_ID,
  )!;
const fullText = (doc: TermsDocument, brand: string) =>
  renderTerms(doc, brand)
    .sections.flatMap((s) => [s.title, ...s.clauses.map((c) => c.text)])
    .join('\n');

describe('the terms document (C-24)', () => {
  it('carries the version the purchase consent records, in both languages and on the fake backend', () => {
    expect(termsAr.version).toBe(SUBSCRIPTION_TERMS_VERSION);
    expect(termsEn.version).toBe(SUBSCRIPTION_TERMS_VERSION);
    expect(FAKE_SUBSCRIPTION_TERMS_VERSION).toBe(SUBSCRIPTION_TERMS_VERSION);
    expect(studentPlan().terms_version).toBe(SUBSCRIPTION_TERMS_VERSION);
    expect(termsAr.updatedAt).toBe(termsEn.updatedAt);
  });

  it('has the fifteen sections in order, the same in Arabic and English, clause for clause', () => {
    expect(termsAr.sections.map((s) => s.id)).toEqual([
      'definitions',
      'service',
      'account',
      'pricing',
      'term',
      'daily-use',
      'renewal',
      'freeze',
      'refunds',
      'closures',
      'belongings',
      'complaints',
      'privacy',
      'changes',
      'law',
    ]);
    expect(termsEn.sections.map((s) => s.id)).toEqual(termsAr.sections.map((s) => s.id));
    termsAr.sections.forEach((s, i) => {
      expect(termsEn.sections[i]!.clauses.length, s.id).toBe(s.clauses.length);
      expect(s.clauses.length, s.id).toBeGreaterThan(0);
    });
  });

  it('leaves no placeholder unfilled, uses every plan value, and names no brand literally', () => {
    for (const [doc, brand] of [
      [termsAr, BRAND_AR],
      [termsEn, BRAND_EN],
    ] as const) {
      for (const token of TERMS_TOKENS) {
        expect(doc.generic[token], token).toBeTruthy();
        expect(JSON.stringify(doc.sections), `${doc.locale} uses {${token}}`).toContain(`{${token}}`);
      }
      const r = renderTerms(doc, brand);
      const all = [r.title, r.updated, r.intro, fullText(doc, brand)].join('\n');
      expect(all).not.toMatch(/\{[§\w-]+\}/);
      expect(all).toContain(brand);
      expect(r.updated).toContain(SUBSCRIPTION_TERMS_VERSION);
      // the reference «البند 8» points at the freeze section, wherever it moves
      expect(all).toMatch(doc.locale === 'ar' ? /وفق البند 8/ : /under section 8/);
    }
    expect(renderTerms(termsAr, BRAND_AR).updated).toBe(
      `آخر تحديث: 17 نوفمبر 2026 · الإصدار ${SUBSCRIPTION_TERMS_VERSION}`,
    );
  });

  // the subscriptions annex, clause by clause (docs/v2/04 §7.2): each obligation is somewhere in the terms
  it('contains every clause of the subscriptions annex', () => {
    const text = fullText(termsAr, BRAND_AR);
    for (const phrase of [
      // 1 — the student plan
      'مباشرةً إلى',
      'لا تلتزم الجهة المستضيفة بسداد قيمة الاشتراك أو ضمان تحصيلها',
      'الفئة المستفيدة',
      '150 ريالًا',
      'ويظهر مقدارها والإجمالي قبل الدفع',
      '22 يوم خدمة',
      'من الأحد إلى الخميس',
      'ابتداءً من تاريخ التفعيل',
      'زيارة واحدة يوميًا',
      'استلام المركبة وصفّها وإحضارها وتسليمها',
      'في أيام وساعات العمل المعلنة لكل موقع فقط',
      'لمركبة واحدة في الزيارة، ويمكنك تحديث المركبة المسجلة قبل الاستلام',
      'مرة واحدة في كل دورة، حتى 5 أيام خدمة',
      'التجديد اختياري، ويتم بطلبك بعد انتهاء الباقة',
      // 2 — counting the term and holidays
      'لا شهرًا تقويميًا ولا 30 يومًا',
      'الجمعة والسبت',
      'ولو صادفت إجازة دراسية أو رسمية، ما لم يشملها تجميد',
      'تُعرض الإجازات المجدولة في التطبيق قبل الدفع، ولا تُمدَّد الباقة تلقائيًا بسببها، ولك استخدام التجميد خلالها',
      'لا يُرحَّل يوم الخدمة الذي لم تحضر فيه',
      // 3 — activation, renewal, capacity
      'بعد التحقق من أهليتك ثم نجاح الدفع',
      'تاريخ بداية الاشتراك ونهايته وعدد أيام الخدمة المتبقية',
      'تصدر فاتورة لكل دفعة، ونحفظ سجل موافقتك على الشروط والسعر',
      'لا نخصم مبلغ التجديد تلقائيًا دون موافقة مستقلة صريحة منك',
      'الاشتراك شخصي وغير قابل للمشاركة',
      'الطاقة الاستيعابية المعتمدة',
      'يُعلن أي تعديل في السعر قبل التجديد، ولا يسري على الفترة المدفوعة',
      // 4 — the freeze
      'مسبقًا عبر التطبيق بتحديد تاريخ البداية وتاريخ العودة، ولا يُطبَّق بأثر رجعي',
      'تتوقف الخدمة واحتساب الأيام أثناء التجميد',
      'إعادة التفعيل المبكر',
      'وفق الأيام المجمدة فعليًا',
      'ولا يُعوَّض عنها',
      'مستنفدًا لتلك الدورة بعد استخدامه، ولو كانت مدته أقل',
      // 5 — cancellation, closures, the exceptional refund
      'غير قابلة للاسترداد بعد إتمام الدفع',
      'قبل التفعيل أو بعده، مع احتفاظك بحق التجميد',
      'يظهر شرط عدم الاسترداد بوضوح قبل الدفع، وتُوثَّق موافقتك عليه',
      'لا يُخل هذا الشرط بحقوقك النظامية',
      'تسوية الفترات غير المنفذة',
      'قرارات الجهة المستضيفة أو الجهات المختصة، وأعمال الصيانة، والظروف الطارئة',
      'لا تتحمل',
      'يستمر احتساب مدة الاشتراك خلال الإغلاق دون استرداد أو تمديد تلقائي',
      'في حدود ما تجيزه الأنظمة',
      'نبلغك بالإغلاق عند العلم به',
      'لاستحالة تقديم الخدمة',
      'تُوثَّق التسوية',
      'بنسبة عددها إلى',
      'تسوية الضريبة نظامًا',
      'وسيلة الدفع الأصلية أو بديل موثّق خلال 12 يومًا تقويميًا',
      'دون تجاوز أي مدة نظامية أقصر',
      'يكون الدفع وطلبات التجميد والشكاوى عبر التطبيق',
      // 6 — use, complaints, consent, belongings
      'يتوقف الاستخدام المستقبلي للاشتراك عند انتهاء الباقة أو عدم السداد، دون حجز مركبتك أو مفتاحها',
      'برقم مرجعي',
      'تُعرض الشروط وسياسة الخصوصية قبل الدفع وتُوثَّق موافقتك عليهما',
      'لا تُسقط هذه الموافقة أيًا من حقوقك النظامية',
      'قبل الاشتراك وقبل الاستلام إلى إخراج مقتنياتك الشخصية والثمينة',
      'لا تشمل جردها أو حفظها بصورة مستقلة',
      'أفعال تابعيها أثناء حيازة المركبة، وفق الأنظمة السعودية',
    ])
      expect(text, phrase).toContain(phrase);
  });

  it('reads with the values of the plan it was opened from (a service-day plan)', () => {
    const plan = studentPlan();
    const v = planTermsValues(
      { name: plan.name_ar, policy: plan.policy, netHalalas: plan.monthly_breakdown!.net_halalas },
      'ar',
      ar,
    );
    expect(v).toEqual({
      serviceDays: '22 يوم خدمة',
      serviceWeek: 'من الأحد إلى الخميس',
      offDays: 'الجمعة والسبت',
      price: '150.00 ر.س قبل الضريبة لكل دورة',
      dailyLimit: 'زيارة واحدة يوميًا',
      freezeLimit: 'مرة واحدة في كل دورة، حتى 5 أيام خدمة',
      freezeDays: 'حد التجميد (5 أيام خدمة)',
    });
    const view = termsView('ar', BRAND_AR, ar, {
      name: plan.name_ar,
      policy: plan.policy,
      netHalalas: plan.monthly_breakdown!.net_halalas,
    });
    expect(view.planNote).toContain(plan.name_ar);
    const term = view.sections.find((s) => s.id === 'term')!;
    expect(term.clauses[0]!.text).toBe(
      'مدة الدورة 22 يوم خدمة، تُحتسب من الأحد إلى الخميس ابتداءً من تاريخ التفعيل.',
    );
    const en5 = termsView('en', BRAND_EN, en, {
      name: plan.name_ar,
      policy: plan.policy,
      netHalalas: null,
    }).sections.find((s) => s.id === 'term')!;
    expect(en5.clauses[0]!.text).toBe(
      'A term is 22 service days, counted Sunday to Thursday from the activation date.',
    );
    expect(en5.clauses[2]!.text).toMatch(/^Friday and Saturday do not count\./);
    // a calendar plan (V4) keeps the generic wording: no plan note
    const v4 = FAKE_LOCATIONS[0]!.plans[0]!;
    expect(
      termsView('ar', BRAND_AR, ar, { name: v4.name_ar, policy: v4.policy, netHalalas: null }).planNote,
    ).toBeNull();
    // generic English clauses open with a capital
    expect(termsView('en', BRAND_EN, en).sections.find((s) => s.id === 'term')!.clauses[2]!.text).toMatch(
      /^The other days of the week \(Friday and Saturday on the Student plan\) do not count\./,
    );
  });

  it('is published unchanged as docs/v2/store/TERMS_AR.md and TERMS_EN.md', () => {
    for (const [doc, brand, file] of [
      [termsAr, BRAND_AR, 'TERMS_AR.md'],
      [termsEn, BRAND_EN, 'TERMS_EN.md'],
    ] as const) {
      const url = new URL(`../../../docs/v2/store/${file}`, import.meta.url);
      const md = termsMarkdown(doc, brand);
      if (process.env.TERMS_DOCS_WRITE === '1') writeFileSync(url, md);
      expect(
        readFileSync(url, 'utf8'),
        `${file}: run TERMS_DOCS_WRITE=1 pnpm --filter @point/customer test`,
      ).toBe(md);
    }
  });
});

describe('counted words and dates (DEC-611)', () => {
  it('writes Arabic counts with their forms and English ones with one / other', () => {
    expect([0, 1, 2, 3, 10, 11, 22, 100, 103, 111].map((n) => countText(n, ar.units.day))).toEqual([
      '0 يوم',
      'يوم واحد',
      'يومان',
      '3 أيام',
      '10 أيام',
      '11 يومًا',
      '22 يومًا',
      '100 يوم',
      '103 أيام',
      '111 يومًا',
    ]);
    expect([1, 2, 5, 22].map((n) => countText(n, ar.units.serviceDay))).toEqual([
      'يوم خدمة واحد',
      'يوما خدمة',
      '5 أيام خدمة',
      '22 يوم خدمة',
    ]);
    expect([1, 2, 22].map((n) => countText(n, en.units.serviceDay))).toEqual([
      '1 service day',
      '2 service days',
      '22 service days',
    ]);
    expect(countText(1, ar.units.time)).toBe('مرة واحدة');
  });

  it('shows a term as one compact range, the year once unless it changes', () => {
    expect(rangeText('2026-11-08', '2026-12-07', ar)).toBe('8 نوفمبر – 7 ديسمبر 2026');
    expect(rangeText('2026-12-27', '2027-01-07', ar)).toBe('27 ديسمبر 2026 – 7 يناير 2027');
    expect(rangeText('2026-11-08', '2026-12-07', en)).toBe('8 Nov – 7 Dec 2026');
  });

  it('C-09 names the student plan by its service days, never «شهري»', () => {
    const a = planAnnex(studentPlan(), ar);
    expect(a.term).toBe('22 يوم خدمة · من الأحد إلى الخميس');
    expect(a.countedNote).toBe('الدورة 22 يوم خدمة، لا شهرًا تقويميًا ولا 30 يومًا.');
    expect(a.bullets.map((b) => b.text)).toContain('تجميد مرة واحدة في كل دورة، حتى 5 أيام خدمة');
  });
});
