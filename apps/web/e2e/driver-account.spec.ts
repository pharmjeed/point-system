import { expect, test } from '@playwright/test';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { arrangeRetrieval, pressCommand, startDuty } from './support/driver';
import { audioLog, installFakeAudio } from './support/fakeAudio';
import { createFake } from './support/fake';
import { permissionRequests, standaloneDisplay, stubNotifications } from './support/notifications';

/**
 * PNT-070 (D-14 «حسابي» and the PWA setup of the device) and the in-page alert mode of PNT-072 / AC-22, on the
 * fake backend: duty and break, the cash in hand, the end of shift and its custody refusal, the sound test and
 * the device notifications from a tap only (never on load), the «أضف إلى الشاشة الرئيسية» guide only outside the
 * installed app, and the clear in-page alert mode when notifications are refused — with the work still possible.
 */
runOnlyAt390();
fakeOnly();

test('PNT-070: D-14 shows the duty, the cash in hand and the device; the break switch and the end of shift', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV2');
  fake.world.payments.push({
    id: crypto.randomUUID(),
    ticket_id: crypto.randomUUID(),
    method: 'cash',
    amount_halalas: 12000,
    pos_reference: null,
    collected_by: fake.userByKey('DRV2').id,
    collected_at: new Date().toISOString(),
  });
  const { page, session } = await actorPage(browser, fake, 'DRV2');
  await page.goto('/d/account');
  await expect(page.getByText(/^الموقع: قاعة ريماس · بدأت الوردية \d{1,2}:\d{2} [صم]$/)).toBeVisible();
  await expect(page.locator('[data-row="cash"]')).toHaveText('نقد بعهدتك: 120.00 ر.س');
  await expect(page.locator('[data-row="version"]')).toContainText(
    `الجهاز ${(session.deviceId as string).slice(0, 8)}`,
  );

  // استراحة: on, then off (POST /v1/me/duty/break with an Idempotency-Key)
  const breakSwitch = page.getByRole('switch', { name: 'استراحة' });
  await expect(breakSwitch).not.toBeChecked();
  await breakSwitch.click();
  await expect(breakSwitch).toBeChecked();
  expect(fake.callsTo('POST /v1/me/duty/break').at(-1)?.body).toEqual({ active: true });
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await expect(page.getByText('أنت في استراحة ولن تصلك الطلبات.')).toBeVisible();
  await page.getByRole('link', { name: 'حسابي' }).click();
  await page.getByRole('switch', { name: 'استراحة' }).click();
  await expect(page.getByRole('switch', { name: 'استراحة' })).not.toBeChecked();

  // إنهاء الوردية (02 D-14 dialog) → off duty: «بدء الوردية» is offered instead
  await page.getByRole('button', { name: 'إنهاء الوردية' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('إنهاء الوردية؟ لن تصلك طلبات بعد الآن.');
  await pressCommand(fake, 'POST /v1/me/duty/end', dialog.getByRole('button', { name: 'إنهاء الوردية' }));
  await expect(page.getByRole('button', { name: 'بدء الوردية' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'استراحة' })).toHaveCount(0);
});

test('PNT-070: the end of shift with custody in hand shows DUTY_END_BLOCKED_CUSTODY items', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { displayNumber } = arrangeRetrieval(fake, 'DRV1', 'key'); // DRV1 holds the key
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d/account');
  await page.getByRole('button', { name: 'إنهاء الوردية' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'إنهاء الوردية' }).click();
  await expect(page.getByRole('alertdialog')).toContainText(
    `لا يمكن إنهاء الوردية وبعهدتك: مفتاح #${displayNumber}`,
  );
  await expect(page.getByRole('alertdialog')).toContainText('أنهِها أو سلّمها للمشرف.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'فهمت' }).click();
  await expect(page.getByRole('switch', { name: 'استراحة' })).toBeVisible(); // still on duty
});

test('PNT-070 AC2 / AC-22: no permission prompt without a tap; refused → the in-page alert mode, work goes on', async ({
  browser,
}) => {
  const fake = createFake();
  const { page, session } = await actorPage(browser, fake, 'DRV1');
  await stubNotifications(page, { permission: 'default', answer: 'denied' });
  await page.goto('/d/start');
  await expect(page.getByRole('button', { name: 'بدء الوردية' })).toBeVisible();
  startDuty(fake, 'DRV1');
  await page.goto('/d/account');
  await expect(page.getByRole('button', { name: 'تفعيل الإشعارات' })).toBeVisible();
  expect(await permissionRequests(page)).toBe(0); // 05 §15.3: never on load

  await page.getByRole('button', { name: 'تفعيل الإشعارات' }).click();
  expect(await permissionRequests(page)).toBe(1);
  const mode = page.getByRole('status').filter({ hasText: 'وضع التنبيه: داخل الصفحة فقط' });
  await expect(mode).toHaveText(/أبقِ الصفحة مفتوحة أثناء الوردية/);
  await expect(mode).toContainText('الإشعارات مرفوضة؛ أبقِ');
  await expect
    .poll(() => fake.devices.get(session.deviceId as string)?.notification_permission)
    .toBe('denied');

  // AC-22: the core work does not depend on notifications
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('button', { name: 'استلام مركبة' }).click();
  await page
    .getByRole('dialog', { name: 'لأي حفل هذه المركبة؟' })
    .getByRole('button', { name: /حفل تجريبي — ريماس 1/ })
    .click();
  await expect(page).toHaveURL(/\/d\/intake\/.+\/vehicle$/);
});

test('PNT-070: granted from the tap — the device stores the permission (no subscription without a worker)', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { page, session } = await actorPage(browser, fake, 'DRV1');
  await stubNotifications(page, { permission: 'default', answer: 'granted' });
  await page.goto('/d/account');
  await page.getByRole('button', { name: 'تفعيل الإشعارات' }).click();
  await expect(page.locator('[data-row="notifications"]')).toContainText('مفعّلة');
  await expect
    .poll(() => fake.devices.get(session.deviceId as string)?.notification_permission)
    .toBe('granted');
  const put = fake.callsTo('PUT /v1/me/devices/:deviceId').at(-1);
  expect(put?.body).toMatchObject({ notification_permission: 'granted', display_mode: 'browser' });
  await expect(page.getByText('وضع التنبيه: داخل الصفحة فقط')).toHaveCount(0);
});

test('PNT-070 AC2: the home-screen guide only outside the installed app', async ({ browser }) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const tab = await actorPage(browser, fake, 'DRV1');
  await tab.page.goto('/d/account');
  const link = tab.page.getByRole('button', { name: /كيف أضيف .+ إلى الشاشة الرئيسية؟/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(tab.page.getByRole('dialog')).toContainText('اختر «إضافة إلى الشاشة الرئيسية».');

  const installed = await actorPage(browser, fake, 'DRV1');
  await standaloneDisplay(installed.page);
  await installed.page.goto('/d/account');
  await expect(installed.page.getByRole('heading', { name: 'حسابي' })).toBeVisible();
  await expect(installed.page.getByText(/إلى الشاشة الرئيسية؟/)).toHaveCount(0);
});

test('PNT-066/070: the D-14 sound test unlocks, plays `test` and records «heard» on the device', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { page, session } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  await page.goto('/d/account');
  await page.getByRole('button', { name: 'تفعيل واختبار الصوت' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('هل سمعت النغمة؟');
  expect((await audioLog(page)).started).toEqual(['test']);
  await page.getByRole('button', { name: 'نعم، سمعتها' }).click();
  await expect(page.locator('[data-row="audio"]')).toContainText(/يعمل · آخر اختبار/);
  await expect.poll(() => fake.devices.get(session.deviceId as string)?.audio_test_result).toBe('heard');
  // sound on: the D-15 د banner is gone from D-04
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await expect(page.getByText('الصوت متوقف — اضغط هنا لتفعيله.')).toHaveCount(0);
});
