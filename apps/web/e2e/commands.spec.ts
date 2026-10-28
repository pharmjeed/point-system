import { expect, test } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import { apiError, driverMe, MockApi, ok } from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * The command contract every operational button will use (02 §1.8, 03 §3.1, 07 §1.4), exercised on
 * «بدء الوردية» (D-03): Idempotency-Key + CSRF header, «جارٍ…» while pending, one request per press,
 * the same key after a network failure, server text on business errors.
 */
runOnlyAt390();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const started = () => ok({ duty_session: { status: 'on_duty' }, driver_state: 'available' }, 201);

test('sends Idempotency-Key and X-Requested-With, shows «جارٍ…», then goes to D-04', async ({ page }) => {
  const api = new MockApi(page, driverMe());
  api.on('POST', '/v1/me/duty/start', async () => {
    await new Promise((r) => setTimeout(r, 500));
    api.me = driverMe({ onDuty: true });
    return started();
  });
  await api.install();
  await page.goto('/d/start');
  const button = page.getByRole('button', { name: 'بدء الوردية' });
  await button.click();
  await expect(page.locator('#duty-start')).toHaveText(/جارٍ…/);
  await expect(page.locator('#duty-start')).toBeDisabled();
  await page.locator('#duty-start').click({ force: true }); // a second press while pending
  await expect(page).toHaveURL(/\/d$/);
  const calls = api.callsTo('POST', '/v1/me/duty/start');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.headers['idempotency-key']).toMatch(UUID_V4);
  expect(calls[0]?.headers['x-requested-with']).toBe('point-web');
});

test('a network failure is retried with the same key (no duplicate effect)', async ({ page }) => {
  const api = new MockApi(page, driverMe());
  api.sequence('POST', '/v1/me/duty/start', ['abort', started()]);
  await api.install();
  await page.goto('/d/start');
  await page.getByRole('button', { name: 'بدء الوردية' }).click();
  await expect(page).toHaveURL(/\/d$/);
  const keys = api.callsTo('POST', '/v1/me/duty/start').map((c) => c.headers['idempotency-key']);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('a business error shows the server text under the button; the next press uses a new key', async ({
  page,
}) => {
  const api = new MockApi(page, driverMe());
  api.sequence('POST', '/v1/me/duty/start', [apiError('SHIFT_NOT_OPEN', 409), started()]);
  await api.install();
  await page.goto('/d/start');
  await page.getByRole('button', { name: 'بدء الوردية' }).click();
  await expect(page.getByRole('alert').filter({ hasText: errorMessagesAr.SHIFT_NOT_OPEN })).toBeVisible();
  await page.getByRole('button', { name: 'بدء الوردية' }).click();
  await expect(page).toHaveURL(/\/d$/);
  const keys = api.callsTo('POST', '/v1/me/duty/start').map((c) => c.headers['idempotency-key']);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test('DUTY_ALREADY_STARTED moves silently to D-04', async ({ page }) => {
  const api = new MockApi(page, driverMe());
  api.on('POST', '/v1/me/duty/start', () => {
    api.me = driverMe({ onDuty: true });
    return apiError('DUTY_ALREADY_STARTED', 409);
  });
  await api.install();
  await page.goto('/d/start');
  await page.getByRole('button', { name: 'بدء الوردية' }).click();
  await expect(page).toHaveURL(/\/d$/);
});
