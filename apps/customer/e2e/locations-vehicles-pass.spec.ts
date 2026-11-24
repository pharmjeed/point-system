/**
 * Locations, vehicles and the entry pass (docs/v2/01 R2 step 1, R3 step 1, R6): C-07 search and filters → C-08
 * hours, prices and «اشترك»; C-15 add a second car and delete one (with its confirmation); C-11 the rotating QR
 * with the vehicle choice. The map of C-07 and «زد السطوع» are native (Maestro, DEC-553).
 */
import {
  addVehicle,
  ar,
  button,
  expect,
  expectHome,
  expectRtlPhone,
  heading,
  passButton,
  subscribeFromHome,
  shown,
  signUp,
  test,
  tpl,
} from './support/app';

test('C-07 → C-08: search, filter, open a location with its hours and prices', async ({ app: page }) => {
  await signUp(page);
  await addVehicle(page);
  await expectHome(page);
  // without a subscription (DEC-639): the search bar over the map opens the full list
  await page.getByRole('search', { name: ar.home.places.search }).filter({ visible: true }).click();
  await expect(heading(page, ar.locations.title)).toBeVisible();
  await expectRtlPhone(page);
  const rows = page.getByRole('button', { name: new RegExp(ar.locations.listSeparator) });
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();
  expect(total).toBeGreaterThan(1);

  // «يقبل الاشتراك» keeps only locations that sell subscriptions; «مشترك فيه» is empty for a new account
  const filters = page.getByRole('radiogroup', { name: ar.locations.filterLabel });
  await filters.getByRole('radio', { name: ar.locations.filters.subscribable }).click();
  await expect.poll(() => rows.count()).toBeLessThan(total);
  await filters.getByRole('radio', { name: new RegExp(ar.locations.filters.subscribed) }).click();
  await expect(shown(page.getByText(ar.locations.emptySubscribed, { exact: true }))).toBeVisible();
  await filters.getByRole('radio', { name: new RegExp(ar.locations.filters.all) }).click();
  await expect.poll(() => rows.count()).toBe(total);

  // search by name: the first location's own title narrows the list to it
  const first = (await rows.first().getAttribute('aria-label'))?.split(ar.locations.listSeparator)[0] ?? '';
  await page.getByLabel(ar.locations.searchLabel, { exact: true }).fill(first.slice(0, 6));
  await expect.poll(() => rows.count()).toBeLessThan(total);
  await page.getByLabel(ar.locations.searchLabel, { exact: true }).fill('لا يوجد موقع بهذا الاسم');
  await expect(shown(page.getByText(ar.locations.emptyFiltered, { exact: true }))).toBeVisible();
  await page.getByLabel(ar.locations.searchLabel, { exact: true }).fill('');

  // C-08
  await rows.first().click();
  await expect(heading(page, first)).toBeVisible();
  for (const h of [ar.locations.plan.title, ar.locations.address, ar.locations.hours])
    await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
  await expect(shown(page.getByText(new RegExp(`\\(${ar.locations.today}\\)`)))).toBeVisible();
  // «اختر باقتك» (DEC-640): the yearly best value chosen, priced by the working day, the per-visit price struck
  const cards = page.getByRole('radiogroup', { name: ar.locations.plan.title }).getByRole('radio');
  await expect(cards.first()).toBeChecked();
  await expect(cards.first()).toHaveAttribute('aria-label', new RegExp(ar.locations.plan.perDay));
  await expect(shown(page.getByText(ar.locations.plan.withoutSub, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.locations.plan.basis)))).toBeVisible();
  const subscribe = page.getByTestId('location-subscribe').filter({ visible: true });
  await expect(subscribe).toHaveAccessibleName(tpl(ar.locations.plan.subscribeYearly));
  // the monthly card changes the action
  await cards.nth(1).click();
  await expect(subscribe).toHaveAccessibleName(tpl(ar.locations.plan.subscribeMonthly));
  await expectRtlPhone(page);
});

test('C-15: add a second car, delete one after confirming', async ({ app: page }) => {
  await signUp(page);
  await addVehicle(page, '1111', ['A', 'B', 'D']);
  await expectHome(page);
  await button(page, ar.home.myVehicles).click();
  await expect(heading(page, ar.vehicles.title)).toBeVisible();
  const remove = button(page, ar.vehicles.remove);
  await expect(remove).toHaveCount(1);

  await button(page, ar.vehicles.add).click();
  await addVehicle(page, '2222', ['R', 'S', 'T']);
  await expect(heading(page, ar.vehicles.title)).toBeVisible();
  await expect(remove).toHaveCount(2);
  await expectRtlPhone(page);

  // the same plate twice is refused
  await button(page, ar.vehicles.add).click();
  await addVehicle(page, '2222', ['R', 'S', 'T']);
  await expect(shown(page.getByText(ar.vehicle.duplicate, { exact: true }))).toBeVisible();
  await button(page, ar.vehicles.cancel).click();

  // delete asks first; «إلغاء» keeps the car, «حذف» removes it
  await expect(heading(page, ar.vehicles.title)).toBeVisible();
  page.once('dialog', (d) => d.dismiss());
  await remove.first().click();
  await expect(remove).toHaveCount(2);
  page.once('dialog', async (d) => {
    expect(d.message()).toContain(ar.vehicles.confirmTitle);
    await d.accept();
  });
  await remove.first().click();
  await expect(shown(page.getByText(ar.vehicles.removed, { exact: true }))).toBeVisible();
  await expect(remove).toHaveCount(1);
});

test('C-11: the entry pass draws a QR that changes every 30 s, per chosen car', async ({ app: page }) => {
  await signUp(page);
  await addVehicle(page, '1111', ['A', 'B', 'D']);
  await expectHome(page);
  // the entry pass comes with a subscription (DEC-639)
  await subscribeFromHome(page);

  // one car: shown under the code
  await passButton(page).click();
  await expect(heading(page, ar.pass.title)).toBeVisible();
  const qr = page.getByRole('img', { name: ar.pass.qrLabel });
  await expect(qr).toBeVisible();
  await expect(shown(page.getByText(ar.pass.hint, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.pass.changesIn)))).toBeVisible();
  await expect(shown(page.getByText(new RegExp(`^${ar.pass.vehicle}: `)))).toBeVisible();
  await expectRtlPhone(page);

  // the code is a new one after its 30-second step
  const before = await qr.innerHTML();
  await page.clock.fastForward('00:31');
  await expect.poll(() => qr.innerHTML()).not.toBe(before);

  // two cars: a choice, and the code follows the chosen car
  await button(page, ar.common.back).first().click();
  await button(page, ar.home.myVehicles).click();
  await button(page, ar.vehicles.add).click();
  await addVehicle(page, '2222', ['R', 'S', 'T']);
  await button(page, ar.vehicles.back).click();
  await passButton(page).click();
  const cars = page.getByRole('radiogroup', { name: ar.pass.vehicle }).getByRole('radio');
  await expect(cars).toHaveCount(2);
  const shown1 = await qr.innerHTML();
  await cars.nth(1).click();
  await expect.poll(() => qr.innerHTML()).not.toBe(shown1);
  await expectRtlPhone(page);
});
