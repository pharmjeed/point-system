/**
 * R1 — first use (docs/v2/01 §1): C-01 welcome → C-02 phone → C-03 WhatsApp code → C-04 name and consents →
 * C-05 vehicle → C-06 home. Plus the C-03 rules a customer meets: a wrong code counts down, «تغيير الرقم».
 */
import {
  addVehicle,
  ar,
  button,
  devCode,
  expect,
  expectHome,
  expectRtlPhone,
  freshPhone,
  heading,
  shown,
  signUp,
  subscribeFromHome,
  test,
  tpl,
} from './support/app';

test('R1: welcome, WhatsApp code, consents, first vehicle, home', async ({ app: page }) => {
  // C-01 (option 4): the interactive picture, three cards in one row, one «ابدأ»; Arabic and right to left
  await expect(heading(page, tpl(ar.welcome.title))).toBeVisible();
  for (const card of ar.welcome.cards)
    await expect(page.getByText(card.title, { exact: true })).toBeVisible();
  const caption = page.getByTestId('welcome-caption');
  await expect(caption).toHaveText(ar.welcome.cards[0]!.body);
  // a card shows its scene and its line; a tap on the picture shows the next one
  await page.getByTestId('welcome-card-2').click();
  await expect(caption).toHaveText(ar.welcome.cards[2]!.body);
  await page.getByTestId('welcome-hero').click();
  await expect(caption).toHaveText(ar.welcome.cards[0]!.body);
  await expectRtlPhone(page);

  await signUp(page, { name: 'سارة' });

  // C-05 (the plate is read left to right inside the RTL screen)
  await expectRtlPhone(page);
  await addVehicle(page, '4321');

  // C-06 without a subscription (DEC-639, option 2): «أين تركن عادةً؟», the places on the map and in the sheet, the
  // first one chosen, «اشترك في هذا المكان», the account button and the four shortcuts; no entry pass yet
  await expectHome(page);
  await expect(heading(page, ar.home.places.title)).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.home.greetingTime, { name: 'سارة' })))).toBeVisible();
  const pins = page.locator('[data-testid^="place-pin-"]:visible');
  await expect(pins.first()).toBeVisible();
  const places = page.getByRole('radiogroup', { name: ar.home.places.title }).getByRole('radio');
  expect(await places.count()).toBe(await pins.count());
  await expect(places.first()).toHaveAttribute('aria-checked', 'true');
  // a pin chooses its place in the list
  await pins.nth(1).click();
  await expect(places.first()).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('radio', { checked: true }).filter({ visible: true })).toHaveCount(1);
  await expect(button(page, ar.home.places.subscribe)).toBeVisible();
  await expect(button(page, ar.home.pass)).toHaveCount(0);
  for (const name of [
    ar.home.account,
    ar.home.myVehicles,
    ar.home.myVisits,
    ar.home.subscriptions,
    ar.settings.invoices,
  ])
    await expect(button(page, name)).toBeVisible();

  // subscribed (DEC-639, option 4): the entry pass circle under «مشترك · {المكان}», the covered car and the renewal
  const venue = await subscribeFromHome(page);
  await expect(heading(page, tpl(ar.home.subscribed, { venue }))).toBeVisible();
  await expect(button(page, ar.home.pass)).toBeVisible();
  const line = page.getByTestId('home-subscription').filter({ visible: true });
  await expect(line).toContainText('4321');
  await expect(line).toContainText(ar.subscribe.monthly);
  await expectRtlPhone(page);
});

test('R1: the vehicle can be skipped, and C-06 offers to add it', async ({ app: page }) => {
  await signUp(page);
  await expect(heading(page, ar.vehicle.title)).toBeVisible();
  await button(page, ar.vehicle.skip).click();
  await expectHome(page);
  await expect(button(page, ar.home.addVehicle)).toBeVisible();
});

test('C-02/C-03: an invalid number is refused, a wrong code counts down, «تغيير الرقم» goes back', async ({
  app: page,
}) => {
  await button(page, ar.welcome.start).click();
  const field = page.getByLabel(ar.phone.label, { exact: true });
  await field.fill('412');
  await expect(button(page, ar.phone.submit)).toBeDisabled();

  await field.fill(freshPhone().slice(1));
  await button(page, ar.phone.submit).click();
  await expect(heading(page, ar.otp.title)).toBeVisible();
  await expect(page.getByText(tpl(ar.otp.sentTo))).toBeVisible();
  await expectRtlPhone(page);

  const code = await devCode(page);
  const wrong = code === '000000' ? '111111' : '000000';
  await page.getByLabel(ar.otp.label, { exact: true }).fill(wrong);
  await button(page, ar.otp.submit).click();
  await expect(page.getByText(tpl(ar.otp.attemptsLeft, { count: 4 }))).toBeVisible();
  // resend waits 60 s (C-03)
  await expect(page.getByRole('button', { name: tpl(ar.otp.resendIn) })).toBeDisabled();

  await button(page, ar.otp.changeNumber).click();
  await expect(heading(page, ar.phone.title)).toBeVisible();
});
