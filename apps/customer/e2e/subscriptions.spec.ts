/**
 * R2 — subscribing (docs/v2/01 §1) and its management (R6): C-08 «اشترك» → C-09 cycle (with the yearly saving),
 * plan, covered car, short terms → C-10 for a subscription (a new card, always kept for the renewal) → C-14 active
 * with its renewal date → cancel the renewal (confirmed) and resume it → change the covered car once a period;
 * C-06 lists the subscription.
 */
import type { Page } from '@playwright/test';
import {
  CARD_OK,
  addVehicle,
  ar,
  button,
  expect,
  expectHome,
  expectRtlPhone,
  heading,
  shown,
  signUp,
  test,
  tpl,
} from './support/app';

async function openSubscribable(page: Page): Promise<string> {
  await button(page, ar.home.allLocations).click();
  await page
    .getByRole('radiogroup', { name: ar.locations.filterLabel })
    .getByRole('radio', { name: ar.locations.filters.subscribable })
    .click();
  const row = page.getByRole('button', { name: new RegExp(ar.locations.listSeparator) }).first();
  const venue = (await row.getAttribute('aria-label'))?.split(ar.locations.listSeparator)[0] ?? '';
  await row.click();
  await expect(heading(page, venue)).toBeVisible();
  await expect(shown(page.getByText(ar.locations.monthly, { exact: true }))).toBeVisible();
  return venue;
}

test('C-08 → C-09 → C-10 → C-14: subscribe yearly with a new card, cancel and resume the renewal', async ({
  app: page,
}) => {
  test.slow();
  await signUp(page);
  await addVehicle(page, '1111', ['A', 'B', 'D']);
  await expectHome(page);
  await expect(shown(page.getByText(ar.home.noSubscriptions, { exact: true }))).toBeVisible();

  const venue = await openSubscribable(page);
  await button(page, ar.subscribe.action).click();

  // C-09
  await expect(heading(page, tpl(ar.subscribe.title, { venue }))).toBeVisible();
  await expectRtlPhone(page);
  await expect(shown(page.getByText(ar.subscribe.terms, { exact: true }))).toBeVisible();
  const cycle = page.getByRole('radiogroup', { name: ar.subscribe.cycle });
  await cycle.getByRole('radio', { name: new RegExp(ar.subscribe.yearly) }).click();
  // «متابعة إلى الدفع» needs a plan first
  await button(page, ar.subscribe.pay).click();
  await expect(shown(page.getByText(ar.subscribe.choosePlan, { exact: true }))).toBeVisible();
  const plans = page.getByRole('radiogroup', { name: ar.subscribe.plan });
  await expect(plans.getByText(tpl(ar.subscribe.saving)).first()).toBeVisible();
  await plans.getByRole('checkbox').first().click();
  await expect(shown(page.getByText(new RegExp(`^${ar.subscribe.total}: `)))).toBeVisible();
  // the only car of the account is chosen already (the tick of Checkbox, 03 §3.9: never colour alone)
  await expect(page.getByRole('checkbox', { name: /1111/ })).toContainText('✓');
  await button(page, ar.subscribe.pay).click();

  // C-10 for a subscription: a new card is always kept for the renewal
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(ar.pay.secureNote, { exact: true })).toBeVisible();
  await expect(sheet.getByRole('checkbox', { name: ar.pay.saveForRenewal })).toBeVisible();
  await expect(sheet.getByRole('button', { name: tpl(ar.pay.applePay) })).toHaveCount(0);
  await sheet.getByLabel(ar.pay.cardNumber, { exact: true }).fill(CARD_OK);
  await sheet.getByLabel(ar.pay.expiry, { exact: true }).fill('12/30');
  await sheet.getByLabel(ar.pay.cvc, { exact: true }).fill('123');
  await sheet.getByLabel(ar.pay.cardName, { exact: true }).fill('SARA A');
  await expectRtlPhone(page);
  await sheet.getByTestId('pay-sheet-submit').click();

  // C-14: active, renews on a date, covers the car
  await expect(heading(page, ar.subscriptions.title)).toBeVisible({ timeout: 15_000 });
  await expect(shown(page.getByText(tpl(ar.subscribe.success, { venue })))).toBeVisible();
  await expect(shown(page.getByText(ar.subscriptionStatus.active, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.subscriptions.renewsOn)))).toBeVisible();
  await expect(shown(page.getByText(new RegExp(`${ar.subscribe.yearly}`)))).toBeVisible();
  await expectRtlPhone(page);

  // cancel the renewal: asks first, then «لن يتجدد»; resume brings it back
  page.once('dialog', async (d) => {
    expect(d.message()).toContain(ar.subscriptions.cancelConfirm);
    await d.accept();
  });
  await button(page, ar.subscriptions.cancel).click();
  await expect(shown(page.getByText(ar.subscriptions.done.canceled, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.subscriptions.canceledAtEnd)))).toBeVisible();
  await button(page, ar.subscriptions.resume).click();
  await expect(shown(page.getByText(ar.subscriptions.done.resumed, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.subscriptions.renewsOn)))).toBeVisible();

  // C-06 shows it under «اشتراكاتي» (back through C-08 and C-07)
  await button(page, ar.common.back).click();
  await expect(heading(page, venue)).toBeVisible();
  await button(page, ar.common.back).click();
  await expect(heading(page, ar.locations.title)).toBeVisible();
  await button(page, ar.common.back).click();
  await expectHome(page);
  await expect(shown(page.getByText(ar.home.noSubscriptions, { exact: true }))).toHaveCount(0);
  await page
    .getByRole('button', { name: new RegExp(venue) })
    .first()
    .click();
  await expect(heading(page, ar.subscriptions.title)).toBeVisible();
});

test('C-14: change the covered car once in the period', async ({ app: page }) => {
  test.slow();
  await signUp(page);
  await addVehicle(page, '1111', ['A', 'B', 'D']);
  await expectHome(page);
  await button(page, ar.home.myVehicles).click();
  await button(page, ar.vehicles.add).click();
  await addVehicle(page, '2222', ['R', 'S', 'T']);
  await button(page, ar.vehicles.back).click();

  await openSubscribable(page);
  await button(page, ar.subscribe.action).click();
  await page.getByRole('radiogroup', { name: ar.subscribe.plan }).getByRole('checkbox').first().click();
  await page.getByRole('checkbox', { name: /1111/ }).click();
  await button(page, ar.subscribe.pay).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel(ar.pay.cardNumber, { exact: true }).fill(CARD_OK);
  await sheet.getByLabel(ar.pay.expiry, { exact: true }).fill('12/30');
  await sheet.getByLabel(ar.pay.cvc, { exact: true }).fill('123');
  await sheet.getByLabel(ar.pay.cardName, { exact: true }).fill('SARA A');
  await sheet.getByTestId('pay-sheet-submit').click();
  await expect(heading(page, ar.subscriptions.title)).toBeVisible({ timeout: 15_000 });
  await expect(shown(page.getByText(tpl(ar.subscriptions.vehicles)))).toContainText('1111');

  await button(page, ar.subscriptions.changeVehicle).click();
  await page.getByRole('checkbox', { name: /1111/ }).click();
  await page.getByRole('checkbox', { name: /2222/ }).click();
  await button(page, ar.subscriptions.save).click();
  await expect(shown(page.getByText(ar.subscriptions.done.vehicles, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.subscriptions.vehicles)))).toContainText('2222');
  // once a period
  await expect(button(page, ar.subscriptions.changeVehicle)).toHaveCount(0);
  await expectRtlPhone(page);
});
