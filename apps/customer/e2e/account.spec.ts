/**
 * R6 — the account (docs/v2/01 §1): C-18 saved cards (add with consent, last 4 digits only, default, delete after
 * confirming); C-17 empty state; C-19 language (English is left to right, back to Arabic), notifications,
 * support, sign-out; C-20 deletion confirmed by a fresh WhatsApp code, and refused while a visit is open.
 */
import {
  CARD_OK,
  DEMO_VISIT_PHONE,
  addVehicle,
  ar,
  button,
  devCode,
  en,
  expect,
  expectHome,
  expectRtlPhone,
  heading,
  openAccount,
  shown,
  signUp,
  test,
  tpl,
} from './support/app';
import type { Page } from '@playwright/test';

async function openSettings(page: Page) {
  await openAccount(page);
}

async function addCard(page: Page, number: string) {
  await button(page, ar.paymentMethods.add).click();
  await page.getByLabel(ar.pay.cardNumber, { exact: true }).fill(number);
  await page.getByLabel(ar.pay.expiry, { exact: true }).fill('11/31');
  await page.getByLabel(ar.pay.cvc, { exact: true }).fill('321');
  await page.getByLabel(ar.pay.cardName, { exact: true }).fill('SARA A');
  // the consent stays ticked after a first card: tick it only when it is not (Checkbox shows «✓», 03 §3.9)
  const consent = page.getByRole('checkbox', { name: ar.paymentMethods.consent });
  if (!(await consent.innerText()).includes('✓')) await consent.click();
  await button(page, ar.paymentMethods.save).click();
  await expect(shown(page.getByText(ar.paymentMethods.added, { exact: true }))).toBeVisible();
}

test('C-18: add two cards, make the second the default, delete one; C-17 starts empty', async ({
  app: page,
}) => {
  await signUp(page);
  await addVehicle(page);
  await expectHome(page);
  await openSettings(page);

  await button(page, ar.settings.invoices).click();
  await expect(heading(page, ar.invoices.title)).toBeVisible();
  await expect(shown(page.getByText(ar.invoices.empty, { exact: true }))).toBeVisible();
  await button(page, ar.invoices.back).click();

  await button(page, ar.settings.paymentMethods).click();
  await expect(heading(page, ar.paymentMethods.title)).toBeVisible();
  await expect(shown(page.getByText(ar.paymentMethods.empty, { exact: true }))).toBeVisible();
  await expectRtlPhone(page);

  await addCard(page, CARD_OK);
  await addCard(page, '4400000000000008');
  const last4 = (d: string) => shown(page.getByText(new RegExp(`•••• [\\u2066-\\u2069]?${d}`)));
  await expect(last4('1111')).toBeVisible();
  await expect(last4('0008')).toBeVisible();
  await expect(page.getByText(CARD_OK)).toHaveCount(0);
  await expect(shown(page.getByText(ar.paymentMethods.default, { exact: true }))).toBeVisible();
  await expectRtlPhone(page);

  // one default at a time
  await button(page, ar.paymentMethods.makeDefault).click();
  await expect(button(page, ar.paymentMethods.makeDefault)).toHaveCount(1);

  // delete asks first
  const remove = button(page, ar.paymentMethods.remove);
  await expect(remove).toHaveCount(2);
  page.once('dialog', async (d) => {
    expect(d.message()).toContain(ar.paymentMethods.confirmTitle);
    await d.accept();
  });
  await remove.first().click();
  await expect(shown(page.getByText(ar.paymentMethods.removed, { exact: true }))).toBeVisible();
  await expect(remove).toHaveCount(1);
});

test('C-19: English switches the copy and the direction, Arabic brings both back; sign out', async ({
  app: page,
}) => {
  await signUp(page);
  await button(page, ar.vehicle.skip).click();
  await expectHome(page);
  await openSettings(page);
  await expectRtlPhone(page);

  // a web/fake build has no EAS project and no support channel configured (DEC-519, DEC-509)
  await expect(shown(page.getByText(ar.push.unavailable, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(ar.settings.supportNone, { exact: true }))).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.settings.version)))).toBeVisible();

  const language = page.getByRole('radiogroup', { name: ar.settings.language });
  await language.getByRole('radio', { name: ar.settings.languageNames.en }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(heading(page, en.settings.title)).toBeVisible();
  await expect(shown(page.getByText(en.settings.languageSaved, { exact: true }))).toBeVisible();
  // the switch is saved on the account too; the next one is taken once that answer is back
  const arabic = page
    .getByRole('radiogroup', { name: en.settings.language })
    .getByRole('radio', { name: ar.settings.languageNames.ar });
  await expect(async () => {
    await arabic.click();
    await expect(heading(page, ar.settings.title)).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expectRtlPhone(page);

  await button(page, ar.settings.signOut).click();
  await expect(heading(page, ar.phone.title)).toBeVisible();
});

test('C-20: delete the account with a fresh WhatsApp code; the app returns to C-01', async ({
  app: page,
}) => {
  await signUp(page);
  await addVehicle(page);
  await expectHome(page);
  await openSettings(page);
  await button(page, ar.settings.deleteAccount).click();

  await expect(heading(page, ar.deleteAccount.title)).toBeVisible();
  await expect(shown(page.getByText(ar.deleteAccount.intro, { exact: true }))).toBeVisible();
  for (const line of ar.deleteAccount.consequences)
    await expect(shown(page.getByText(line, { exact: false }))).toBeVisible();
  await expectRtlPhone(page);

  await button(page, ar.deleteAccount.sendCode).click();
  await expect(page.getByRole('heading', { name: ar.deleteAccount.codeTitle })).toBeVisible();
  await expect(shown(page.getByText(tpl(ar.deleteAccount.codeSentTo)))).toBeVisible();
  const code = await devCode(page);
  await page.getByLabel(ar.otp.label, { exact: true }).fill(code);
  await button(page, ar.deleteAccount.confirm).click();

  await expect(heading(page, tpl(ar.welcome.title))).toBeVisible({ timeout: 15_000 });
  await expectRtlPhone(page);
});

test('C-20: refused while a visit is open', async ({ app: page }) => {
  await signUp(page, { phone: DEMO_VISIT_PHONE });
  await button(page, ar.vehicle.skip).click();
  await expectHome(page);
  await openSettings(page);
  await button(page, ar.settings.deleteAccount).click();
  await button(page, ar.deleteAccount.sendCode).click();
  const code = await devCode(page);
  await page.getByLabel(ar.otp.label, { exact: true }).fill(code);
  await button(page, ar.deleteAccount.confirm).click();
  await expect(shown(page.getByText(ar.deleteAccount.visitActive, { exact: true }))).toBeVisible();
  await expect(heading(page, ar.deleteAccount.title)).toBeVisible();
});
