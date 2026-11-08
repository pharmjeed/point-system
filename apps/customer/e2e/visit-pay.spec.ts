/**
 * R3/R4 — the visit (docs/v2/01 §1): C-06 «الزيارة الجارية» → C-12 live status → «اطلب السيارة» with its
 * confirmation → accepted / on the way / ready as the fake driver moves (the browser clock) → the handover code
 * (6 digits, never before «جاهزة») → delivered → C-13 rating → C-16. And the pay-per-visit sheet (C-10 for a
 * visit): a new card saved with consent → «مدفوع في التطبيق», the card in C-18 and the simplified invoice in C-17.
 *
 * The fake backend gives `DEMO_VISIT_PHONE` a parked car at a location with a per-visit fee (README).
 */
import {
  CARD_OK,
  DEMO_VISIT_PHONE,
  ar,
  button,
  expect,
  expectRtlPhone,
  heading,
  shown,
  signUp,
  test,
  tpl,
} from './support/app';
import type { Page } from '@playwright/test';

async function openVisit(page: Page) {
  await signUp(page, { phone: DEMO_VISIT_PHONE });
  await button(page, ar.vehicle.skip).click();
  const card = page.getByRole('button', { name: new RegExp(`^${ar.home.currentVisit} `) });
  await expect(card).toBeVisible();
  await expect(card).toContainText(ar.ticketStatus.parked);
  await card.click();
  await expect(heading(page, ar.visit.title)).toBeVisible();
  await expectRtlPhone(page);
}

test('C-12: request the car, follow it to the gate, show the handover code, rate it', async ({
  app: page,
}) => {
  test.slow();
  await openVisit(page);
  // the timeline shows what happened so far, with Riyadh times
  for (const label of [ar.visit.steps.received, ar.visit.steps.parked])
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText(ar.visit.steps.ready, { exact: true })).toHaveCount(0);
  // no code before the car is ready
  await expect(button(page, ar.visit.code.show)).toHaveCount(0);

  // «اطلب السيارة» asks first (the native Alert; the browser dialog in the web export)
  page.once('dialog', async (d) => {
    expect(d.message()).toContain(ar.visit.requestConfirmTitle);
    expect(d.message()).toContain(ar.visit.requestConfirmBody);
    await d.accept();
  });
  await button(page, ar.visit.request).click();
  await expect(page.getByText(ar.visit.requested, { exact: true })).toBeVisible();
  await expect(page.getByText(ar.visit.waiting.requested, { exact: true })).toBeVisible();
  await expect(button(page, ar.visit.request)).toHaveCount(0);

  // the driver accepts (15 s), drives (45 s), reaches the gate (90 s) — the live screen follows by itself
  await page.clock.fastForward('00:20');
  await expect(page.getByText(ar.visit.waiting.accepted, { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.clock.fastForward('00:30');
  await expect(page.getByText(ar.visit.waiting.onTheWay, { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.clock.fastForward('00:45');
  await expect(page.getByText(ar.visit.waiting.ready, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expectRtlPhone(page);

  // the handover code: 6 digits, shown on demand and hidden again
  await expect(page.getByText(ar.visit.code.title, { exact: true })).toBeVisible();
  await button(page, ar.visit.code.show).click();
  await expect(page.getByText(/^[\u2066-\u2069]?\d{6}[\u2066-\u2069]?$/)).toBeVisible();
  await expect(page.getByText(tpl(ar.visit.code.expiresIn))).toBeVisible();
  await button(page, ar.visit.code.hide).click();
  await expect(page.getByText(/^[\u2066-\u2069]?\d{6}[\u2066-\u2069]?$/)).toHaveCount(0);

  // handed over (the fake driver delivers 3 minutes after ready) → C-13
  await page.clock.fastForward('03:05');
  // C-13 opens by itself once, after the delivery (optional: «تخطَّ» closes it)
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: ar.rating.title })).toBeVisible({ timeout: 15_000 });
  await expect(heading(page, ar.ticketStatus.delivered)).toBeVisible();
  await expectRtlPhone(page);
  await sheet.getByRole('radio', { name: tpl(ar.rating.star, { n: 5 }) }).click();
  await sheet.getByLabel(ar.rating.noteLabel, { exact: true }).fill('خدمة سريعة');
  await sheet.getByRole('button', { name: ar.rating.submit }).click();
  await expect(page.getByText(ar.rating.thanks, { exact: true })).toBeVisible();

  // C-16: the visit is in the history, rated
  await button(page, ar.visit.back).click();
  await button(page, ar.home.myVisits).click();
  await expect(heading(page, ar.visits.title)).toBeVisible();
  // one row: the place, the Riyadh date (Western digits), the duration, and «قيّمتها»
  const row = page.getByRole('button', { name: /\d{1,2}\/\d{1,2}\/\d{4}/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(tpl(ar.visits.duration));
  await expect(row).toContainText(ar.visits.rated);
  await expectRtlPhone(page);
});

test('C-12 → C-10: pay the visit with a new card saved for later; C-18 and C-17 show it', async ({
  app: page,
}) => {
  await openVisit(page);
  const due = page.getByRole('button', { name: tpl(ar.pay.payNow) });
  await expect(page.getByRole('heading', { name: tpl(ar.pay.due) })).toBeVisible();
  await expect(page.getByText(ar.pay.vatIncluded, { exact: true })).toBeVisible();
  await due.click();

  // the sheet: card fields (left to right), consent to keep the card, then pay
  await expect(page.getByText(ar.pay.secureNote, { exact: true })).toBeVisible();
  await page.getByLabel(ar.pay.cardNumber, { exact: true }).fill(CARD_OK);
  await page.getByLabel(ar.pay.expiry, { exact: true }).fill('12/30');
  await page.getByLabel(ar.pay.cvc, { exact: true }).fill('123');
  await page.getByLabel(ar.pay.cardName, { exact: true }).fill('SARA A');
  await page.getByRole('checkbox', { name: ar.pay.saveCard }).click();
  await expectRtlPhone(page);
  await page.getByTestId('pay-sheet-submit').click();
  // the sheet closes on the server's answer; C-12 now reads «مدفوع في التطبيق» and offers no second payment
  await expect(page.getByText(ar.visit.payment.appPaid, { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: tpl(ar.pay.payNow) })).toHaveCount(0);

  // C-18: the saved card, last 4 digits only
  await button(page, ar.visit.back).click();
  await button(page, ar.home.settings).click();
  await button(page, ar.settings.paymentMethods).click();
  await expect(heading(page, ar.paymentMethods.title)).toBeVisible();
  await expect(page.getByText(/•••• [\u2066-\u2069]?1111/)).toBeVisible();
  await expect(page.getByText(CARD_OK)).toHaveCount(0);
  await expectRtlPhone(page);

  // C-17: the simplified tax invoice of the payment, with its QR
  await button(page, ar.paymentMethods.back).click();
  await button(page, ar.settings.invoices).click();
  await expect(heading(page, ar.invoices.title)).toBeVisible();
  await page.getByTestId('invoice-row').first().click();
  await expect(shown(page.getByText(ar.invoices.simplified))).toBeVisible();
  for (const label of [ar.invoices.number, ar.invoices.seller, ar.invoices.vatNumber, ar.invoices.total])
    await expect(shown(page.getByText(label, { exact: true }))).toBeVisible();
  await expect(page.getByLabel(ar.invoices.qrLabel)).toBeVisible();
  await expect(button(page, ar.invoices.pdf)).toBeVisible();
  await expectRtlPhone(page);
});
