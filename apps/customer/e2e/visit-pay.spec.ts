/**
 * R3/R4 — the visit (docs/v2/01 §1): C-06 «الزيارة الجارية» → C-12 live status → «اطلب السيارة» by **holding** the
 * compact circle of the sheet 3 seconds (a short hold asks nothing and shows the hint; the hold is the confirmation,
 * no dialog: DEC-621, DEC-622, DEC-624) → accepted / on the way / ready as the fake driver moves (the browser clock)
 * → the handover code (6 digits, never before «جاهزة») → delivered → C-13 rating → C-16. The same hold on C-06's big
 * circle (option A, DEC-620) and its keyboard path (Enter → the confirmation dialog), then the code on the green
 * circle. And the pay-per-visit sheet (C-10 for a visit): a new card saved with consent → «مدفوع في التطبيق», the
 * card in C-18 and the simplified invoice in C-17.
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
  holdToRequest,
  openAccount,
  test,
  tpl,
} from './support/app';
import type { Page } from '@playwright/test';

async function openVisit(page: Page) {
  await signUp(page, { phone: DEMO_VISIT_PHONE });
  await button(page, ar.vehicle.skip).click();
  const card = page.getByRole('button', {
    name: new RegExp(`^${ar.home.currentVisit} ${ar.ticketStatus.parked}`),
  });
  await expect(card).toBeVisible();
  await expect(heading(page, ar.home.status.parked)).toBeVisible();
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

  // «اطلب السيارة» is the compact hold circle (DEC-624): one element named «اطلب السيارة» with the hold hint; the
  // words beside it say how
  const control = page.getByRole('button', { name: ar.visit.request, exact: true });
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('data-testid', 'request-car-hold');
  await expect(shown(page.getByText(ar.visit.holdCaption, { exact: true }))).toBeVisible();
  // the hold is the confirmation (DEC-622): no dialog at any point
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  // a short hold (1 s) unwinds and requests nothing; the hint says how
  await holdToRequest(page, 1000);
  await expect(shown(page.getByText(ar.home.holdHint, { exact: true }))).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.getByText(ar.visit.requested, { exact: true })).toHaveCount(0);
  await expect(control).toBeVisible();
  await expect(shown(page.getByText(ar.visit.waiting.requested, { exact: true }))).toHaveCount(0);
  // held 3 s: requested
  await holdToRequest(page);
  // the banner (and, for a moment, the words beside the circle with its check and light burst)
  await expect(shown(page.getByText(ar.visit.requested, { exact: true }))).toBeVisible();
  expect(dialogs).toEqual([]);
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

  // C-16 from C-06's «زياراتي» shortcut (DEC-626): the visit is in the history, rated
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
  await openAccount(page);
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

test('C-06: the circle — a short hold does nothing, Enter asks first, the 3 s hold requests; ready shows the code', async ({
  app: page,
}) => {
  test.slow();
  await signUp(page, { phone: DEMO_VISIT_PHONE });
  await button(page, ar.vehicle.skip).click();
  // parked: «سيارتك متوقفة بأمان» over the blue circle «اطلب سيارتك» (hold 3 s; no dialog for the hold itself)
  await expect(heading(page, ar.home.status.parked)).toBeVisible();
  const control = page.getByRole('button', { name: ar.visit.request, exact: true });
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('data-testid', 'request-car-hold');
  await expect(shown(page.getByText(ar.home.hold, { exact: true }))).toBeVisible();
  await expectRtlPhone(page);

  // a short hold (1 s): nothing is requested, the hint shows under the circle
  await holdToRequest(page, 1000);
  await expect(shown(page.getByText(ar.home.holdHint, { exact: true }))).toBeVisible();
  await page.waitForTimeout(600);
  await expect(heading(page, ar.home.status.parked)).toBeVisible();
  await expect(control).toBeVisible();
  await expectRtlPhone(page);

  // the keyboard reaches the same command through the confirmation dialog: «ليس الآن» keeps the car parked
  await control.focus();
  page.once('dialog', async (d) => {
    expect(d.message()).toContain(ar.visit.requestConfirmTitle);
    await d.dismiss();
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await expect(heading(page, ar.home.status.parked)).toBeVisible();

  // while held: the countdown and «استمر بالضغط…»; released at 3 s: requested, the pill changes, the circle turns
  // into «منذ طلبك m:ss»
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const box = await control.boundingBox();
  if (!box) throw new Error('no circle');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(shown(page.getByText(ar.home.holding, { exact: true }))).toBeVisible();
  // held on past the end (4.2 s): the server answers while the finger is still down, and letting go then is not a
  // tap on the circle the request turned into (it would open C-12)
  await page.waitForTimeout(4200);
  await page.mouse.up();
  await expect(page.getByText(ar.visit.requested, { exact: true })).toBeVisible();
  await expect(heading(page, ar.home.status.requested)).toBeVisible();
  await page.waitForTimeout(600);
  await expect(heading(page, ar.visit.title)).toHaveCount(0);
  await expect(control).toHaveCount(0);
  await expect(page.getByRole('button', { name: new RegExp(`^${ar.visit.since.requested} `) })).toBeVisible();
  expect(dialogs).toEqual([]);
  await expectRtlPhone(page);

  await page.clock.fastForward('00:20');
  await expect(heading(page, ar.home.status.coming)).toBeVisible({ timeout: 15_000 });
  await page.clock.fastForward('01:15');
  await expect(heading(page, ar.home.status.ready)).toBeVisible({ timeout: 15_000 });
  await expectRtlPhone(page);
  // the green circle: the code masked until tapped (the same endpoint as C-12), hidden again on a second tap
  const code = page.getByTestId('home-code').filter({ visible: true });
  await expect(code).toHaveAttribute('aria-label', ar.home.codeHidden);
  await expect(page.getByText(/^[\u2066-\u2069]?\d{3} \d{3}[\u2066-\u2069]?$/)).toHaveCount(0);
  await code.click();
  await expect(shown(page.getByText(/^[\u2066-\u2069]?\d{3} \d{3}[\u2066-\u2069]?$/))).toBeVisible();
  await expectRtlPhone(page);
  await code.click();
  await expect(code).toHaveAttribute('aria-label', ar.home.codeHidden);
});
