import { expect, test } from '@playwright/test';
import { EVENT_ID, MockApi, apiError, mockStaffApi, ok, roleMe } from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * PNT-098, 17 §12 «انقطاع قاعدة البيانات»: while the database cannot be reached the API answers
 * 503 SERVICE_UNAVAILABLE (Retry-After); the operations board (S-02) keeps its last snapshot under the stale
 * banner «بيانات قديمة — آخر مزامنة {وقت}» (02 §1.6 «بلا اتصال») instead of an empty or broken screen, and it
 * recovers once the API answers again — by the next poll or by «إعادة المحاولة».
 */
runOnlyAt390();

test('a 503 during the outage: the last board stays under the stale banner, then it recovers', async ({
  page,
}) => {
  await page.clock.install();
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api);
  let databaseDown = false;
  api.on('GET', `/v1/events/${EVENT_ID}/operations`, () =>
    databaseDown
      ? apiError('SERVICE_UNAVAILABLE', 503, { headers: { 'Retry-After': '2' } })
      : ok(state.board),
  );
  await api.install();
  await page.goto('/ops');
  const items = page.getByRole('list', { name: 'الطابور (الأقدم أولًا)' }).locator(':scope > li');
  const stale = page.getByText(/^بيانات قديمة — آخر مزامنة /);
  await expect(items).toHaveCount(3);
  await expect(stale).toHaveCount(0);

  // the 15 s poll meets the outage; a read is retried twice (1 s, 2 s) before the board reports it
  databaseDown = true;
  const before = api.callsTo('GET', `/v1/events/${EVENT_ID}/operations`).length;
  await page.clock.runFor(16_000);
  await page.clock.runFor(5_000);
  await expect(stale).toBeVisible();
  expect(api.callsTo('GET', `/v1/events/${EVENT_ID}/operations`).length).toBeGreaterThanOrEqual(before + 3);
  // the last snapshot stays on screen, marked as stale (never an empty board)
  await expect(items).toHaveCount(3);

  // still down: «إعادة المحاولة» keeps the banner
  await page.getByRole('button', { name: 'إعادة المحاولة' }).click();
  await page.clock.runFor(4_000);
  await expect(stale).toBeVisible();

  // the database is back: the next poll clears the banner
  databaseDown = false;
  await page.clock.runFor(16_000);
  await expect(stale).toHaveCount(0);
  await expect(items).toHaveCount(3);
});

test('back by «إعادة المحاولة» without waiting for the poll', async ({ page }) => {
  await page.clock.install();
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api);
  let databaseDown = false;
  api.on('GET', `/v1/events/${EVENT_ID}/operations`, () =>
    databaseDown
      ? apiError('SERVICE_UNAVAILABLE', 503, { headers: { 'Retry-After': '2' } })
      : ok(state.board),
  );
  await api.install();
  await page.goto('/ops');
  const stale = page.getByText(/^بيانات قديمة — آخر مزامنة /);
  await expect(page.getByRole('list', { name: 'الطابور (الأقدم أولًا)' }).locator(':scope > li')).toHaveCount(
    3,
  );
  databaseDown = true;
  await page.clock.runFor(21_000);
  await expect(stale).toBeVisible();
  databaseDown = false;
  await page.getByRole('button', { name: 'إعادة المحاولة' }).click();
  await expect(stale).toHaveCount(0);
});
