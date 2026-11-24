/**
 * V2-036 / V2-037 — the subscriptions annex in the app (docs/v2/04 §7; DEC-590 … DEC-605): the student plan of a
 * (fictional) university on C-09 — the price before VAT, the VAT and the total, the counted days and their dates, the
 * policies, the announced closures, the valuables notice, the consent — the application with the student number
 * (pending, then approved by the fake review), the payment with the consent, C-14 with the dates and the counted days
 * left, the freeze, and a complaint with its reference. `ANNEX_SHOTS=<dir>` also saves the screens (390 px only).
 */
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARD_OK,
  addVehicle,
  ar,
  button,
  chip,
  expect,
  expectHome,
  expectRtlPhone,
  heading,
  shown,
  signUp,
  subscribeFromHome,
  test,
  tpl,
  ensurePlan,
  subscribeOnLocation,
} from './support/app';

const UNIVERSITY = 'جامعة الأفق — الحرم الرئيسي';
const shots = process.env.ANNEX_SHOTS;

async function shot(page: Page, name: string) {
  if (!shots || page.viewportSize()?.width !== 390) return;
  mkdirSync(shots, { recursive: true });
  // the screen scrolls inside its own container (React Native web): its top, then its end
  const scroll = (to: 'top' | 'end') =>
    page.evaluate((where) => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('#root *'))) {
        const cs = getComputedStyle(el);
        if (el.offsetParent === null || el.scrollHeight <= el.clientHeight + 4) continue;
        if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
        el.scrollTop = where === 'top' ? 0 : el.scrollHeight;
      }
    }, to);
  await scroll('top');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(shots, `${name}-a.png`) });
  await scroll('end');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}-b.png`) });
}

async function openUniversity(page: Page) {
  // without a subscription the home's search bar opens the full list (DEC-639)
  await page.getByRole('search', { name: ar.home.places.search }).filter({ visible: true }).click();
  await page.getByLabel(ar.locations.searchLabel, { exact: true }).fill('الأفق');
  await page
    .getByRole('button', { name: new RegExp(UNIVERSITY) })
    .first()
    .click();
  await expect(heading(page, UNIVERSITY)).toBeVisible();
  await subscribeOnLocation(page);
  await expect(heading(page, tpl(ar.subscribe.title, { venue: UNIVERSITY }))).toBeVisible();
}

test('C-09 → apply → approved → pay with the consent → C-14 counted days → freeze → complaint', async ({
  app: page,
}) => {
  test.slow();
  await signUp(page);
  await addVehicle(page, '4821', ['A', 'B', 'D']);
  await expectHome(page);
  await openUniversity(page);

  // C-09: the plan, its details before payment
  await ensurePlan(page);
  await expect(shown(page.getByText(ar.annex.details, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(ar.annex.net, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(/150\.00/))).toBeVisible();
  await expect(shown(page.getByText(/22\.50/))).toBeVisible();
  await expect(shown(page.getByText(/172\.50/))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.annex.termPreview)))).toBeVisible();
  await expect(shown(page.getByText(ar.annex.policy.nonRefundable, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(ar.annex.closuresTitle, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(ar.annex.valuables, { exact: true }))).toBeVisible();
  await expectRtlPhone(page);
  // the application needs the number, the name and the consent
  await page.getByTestId('subscribe-apply').click();
  await expect(shown(page.getByText(ar.annex.numberInvalid, { exact: true }))).toBeVisible();
  await page.getByLabel(ar.annex.studentNumber, { exact: true }).fill('441234567');
  await page.getByLabel(ar.annex.studentName, { exact: true }).fill('سارة أحمد');
  await page.getByTestId('subscribe-apply').click();
  await expect(shown(page.getByText(ar.annex.consentNeeded, { exact: true }))).toBeVisible();
  await page.getByRole('checkbox', { name: ar.annex.consentTerms }).click();
  await page.getByRole('checkbox', { name: ar.annex.consentNonRefund }).click();
  await shot(page, '1-subscribe-breakdown-consent');
  await page.getByTestId('subscribe-apply').click();

  // C-14: pending eligibility
  await expect(heading(page, ar.subscriptions.title)).toBeVisible({ timeout: 15_000 });
  await expect(shown(page.getByText(ar.annex.done.applied, { exact: true }))).toBeVisible();
  await expect(
    shown(page.getByText(ar.subscriptionStatus.pending_eligibility, { exact: true })),
  ).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.annex.pendingEligibility)))).toBeVisible();
  await expect(button(page, ar.annex.withdraw)).toBeVisible();
  await expectRtlPhone(page);
  await shot(page, '2-pending-eligibility');

  // the fake review approves after 5 s: «ادفع الآن» → C-09 with the consent → paid
  await page.clock.fastForward(6000);
  // back to C-06 and «اشتراكاتي» again: C-14 reads the subscription anew (DEC-626)
  await button(page, ar.common.back).click();
  await button(page, ar.home.subscriptions).click();
  await expect(shown(page.getByText(tpl(ar.annex.approvedPay)))).toBeVisible();
  await page
    .getByRole('button', { name: ar.subscriptions.pay, exact: true })
    .filter({ visible: true })
    .click();
  await expect(heading(page, tpl(ar.subscribe.title, { venue: UNIVERSITY }))).toBeVisible();
  await page.getByRole('checkbox', { name: ar.annex.consentTerms }).click();
  await page.getByRole('checkbox', { name: ar.annex.consentNonRefund }).click();
  await page.getByTestId('subscribe-pay').click();
  const sheet = page.getByRole('dialog');
  // a plan renewed by hand: the card is not kept for any renewal
  await expect(sheet.getByRole('checkbox', { name: ar.pay.saveForRenewal })).toHaveCount(0);
  await sheet.getByLabel(ar.pay.cardNumber, { exact: true }).fill(CARD_OK);
  await sheet.getByLabel(ar.pay.expiry, { exact: true }).fill('12/30');
  await sheet.getByLabel(ar.pay.cvc, { exact: true }).fill('123');
  await sheet.getByLabel(ar.pay.cardName, { exact: true }).fill('SARA A');
  await sheet.getByTestId('pay-sheet-submit').click();

  // C-14 active: the period, the counted days left, non-refundable, «تجميد»
  await expect(heading(page, ar.subscriptions.title)).toBeVisible({ timeout: 15_000 });
  await expect(shown(page.getByText(ar.subscriptionStatus.active, { exact: true }))).toBeVisible();
  // one compact range (no «يبدأ يوم» line), the days left, «22 يوم خدمة» instead of «شهري» (DEC-612)
  await expect(shown(page.getByText(/^\d{1,2}\u00a0\S+ – \d{1,2}\u00a0\S+\u00a0\d{4}$/))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.annex.remaining, { total: 22 })))).toBeVisible();
  await expect(shown(page.getByText(/· 22 يوم خدمة$/))).toBeVisible();
  await expect(
    page.getByText(new RegExp(`· ${ar.subscribe.monthly}$`)).filter({ visible: true }),
  ).toHaveCount(0);
  await expect(
    shown(page.getByText(`${ar.annex.nonRefundableNote} · ${ar.annex.manualRenewalNote}`, { exact: true })),
  ).toBeVisible();
  await expect(button(page, ar.subscriptions.cancel)).toHaveCount(0);
  await expectRtlPhone(page);
  await shot(page, '3-active-dates-remaining');
  // «الشروط» on the card opens C-24 with this plan's values (DEC-612)
  await page.getByRole('link', { name: ar.annex.terms, exact: true }).filter({ visible: true }).click();
  await expect(heading(page, ar.terms.title)).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.terms.planValues)))).toBeVisible();
  await page.getByRole('button', { name: ar.common.back, exact: true }).filter({ visible: true }).click();
  await expect(heading(page, ar.subscriptions.title)).toBeVisible();

  // the freeze: the second offered start day, back three counted days later
  await page.getByRole('button', { name: ar.annex.freeze, exact: true }).filter({ visible: true }).click();
  await expect(heading(page, ar.annex.freezeTitle)).toBeVisible();
  await chip(page, ar.annex.freezeStart, 1).click();
  await chip(page, ar.annex.freezeReturn, 2).click();
  await expect(shown(page.getByText(tpl(ar.annex.freezeSummary, { days: '3 أيام خدمة' })))).toBeVisible();
  await expectRtlPhone(page);
  await shot(page, '4-freeze-request');
  await page.getByTestId('freeze-submit').click();
  await expect(heading(page, ar.subscriptions.title)).toBeVisible();
  await expect(shown(page.getByText(ar.annex.done.freezeScheduled, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.annex.freezeScheduled)))).toBeVisible();
  await expect(button(page, ar.annex.cancelFreeze)).toBeVisible();

  // a complaint gets its reference at once
  await page.getByTestId('complaints-link').filter({ visible: true }).click();
  await expect(heading(page, ar.annex.complaintsTitle)).toBeVisible();
  await page.getByTestId('complaint-new').click();
  await expect(heading(page, ar.annex.newComplaint)).toBeVisible();
  await chip(page, ar.annex.complaintCategory, 1).click();
  await page
    .getByLabel(ar.annex.complaintBody, { exact: true })
    .fill('تأخر إحضار السيارة أكثر من نصف ساعة اليوم');
  await page.getByTestId('complaint-submit').click();
  await expect(heading(page, ar.annex.complaintsTitle)).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.annex.complaintSent)))).toBeVisible();
  await expect(shown(page.getByText(/PT-C-\d{6}/))).toBeVisible();
  await expect(shown(page.getByText(ar.annex.complaintStatus.open, { exact: true }))).toBeVisible();
  await expectRtlPhone(page);
  await shot(page, '5-complaint-reference');
});

test('C-11: the valuables reminder under the entry pass', async ({ app: page }) => {
  await signUp(page);
  await addVehicle(page, '1111', ['A', 'B', 'D']);
  await expectHome(page);
  await subscribeFromHome(page);
  await page
    .getByRole('button', { name: ar.home.pass, exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(shown(page.getByText(ar.annex.valuables, { exact: true }))).toBeVisible();
});
