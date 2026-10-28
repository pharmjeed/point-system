import { expect, test } from '@playwright/test';
import {
  boardFixture,
  EVENT_ID,
  eventFixture,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  secondsAgo,
  ticketFixture,
  VENUE_ID,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-02 — لوحة التشغيل (PNT-074): the queue oldest first with its waiting counter, escalation badges, tabs below
 * 1024px, the merged board of «كل الحفلات المفتوحة», and the board's live refresh by polling.
 */
runOnlyAt390();

test('the queue is oldest first with the waiting time and the «متأخر» badge', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('لوحة التشغيل');

  const items = page.getByRole('list', { name: 'الطابور (الأقدم أولًا)' }).locator(':scope > li');
  await expect(items).toHaveCount(3);
  // the reply is 52, 47, 50; requested 40 s, 310 s and 130 s ago
  await expect(items.nth(0)).toHaveAttribute('data-ticket', '47');
  await expect(items.nth(1)).toHaveAttribute('data-ticket', '50');
  await expect(items.nth(2)).toHaveAttribute('data-ticket', '52');

  const oldest = items.nth(0);
  await expect(oldest.locator('.pt-queue__timer')).toHaveText(/^5:1\d$/);
  await expect(oldest).toContainText('متأخر');
  await expect(oldest).toContainText('غير مُسند');
  await expect(items.nth(1)).toContainText('بث');
  await expect(items.nth(2)).toContainText('معروض على خالد العتيبي');

  // the counter ticks locally from server time, without a new request
  const before = await oldest.locator('.pt-queue__timer').textContent();
  await expect(oldest.locator('.pt-queue__timer')).not.toHaveText(before ?? '', { timeout: 3000 });

  // indicators
  const kpis = page.locator('.pt-kpistrip').first();
  await expect(kpis).toContainText('طلبات مفتوحة');
  await expect(kpis).toContainText('أقدم انتظار');
  await expect(kpis).toContainText(/5:1\d/);
  await expect(kpis).toContainText('مشغول 1 · استراحة 1');
});

test('tabs show one section at a time below 1024px; drivers, next tasks and custody', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops');
  const queuePanel = page.locator('#ops-panel-queue');
  await expect(queuePanel).toBeVisible();
  await expect(page.locator('#ops-panel-drivers')).toBeHidden();

  await page.getByRole('tab', { name: /السائقون/ }).click();
  await expect(queuePanel).toBeHidden();
  const drivers = page.locator('#ops-panel-drivers');
  await expect(drivers).toBeVisible();
  const saad = drivers.locator('.pt-driverrow-wrap').filter({ hasText: 'سعد الحربي' });
  await expect(saad).toContainText('#44');
  await expect(saad).toContainText('#45');
  // vehicle + key of #44 (moving) and the key of #39 (custody issue)
  await expect(saad).toContainText('3');

  await page.getByRole('tab', { name: /التالية/ }).click();
  await expect(page.locator('#ops-panel-next')).toContainText('انتظار طويل');

  await page.getByRole('tab', { name: /العهدة/ }).click();
  await expect(page.locator('#ops-panel-custody')).toContainText('#39');
  await expect(page.locator('#ops-panel-custody')).toContainText('المفتاح — السائق سعد الحربي');

  await page.getByRole('tab', { name: /الرسائل الفاشلة/ }).click();
  await expect(page.locator('#ops-panel-failed')).toContainText('فشل إرسال W-05');
});

test('«كل الحفلات المفتوحة» merges the boards; choosing one event narrows it', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  const second = eventFixture({ id: 'e-rms-2', name_ar: 'حفل آل خالد' });
  api.on('GET', `/v1/venues/${VENUE_ID}/events`, ok([eventFixture(), second]));
  api.on(
    'GET',
    '/v1/events/e-rms-2/operations',
    ok(
      boardFixture({
        event: second,
        queue: [
          {
            task_id: 'k-60',
            ticket: ticketFixture(60, { status: 'requested', event_id: 'e-rms-2' }),
            status: 'queued',
            requested_at: secondsAgo(500),
            waiting_seconds: 500,
          },
        ],
        alerts: [],
      }),
    ),
  );
  await api.install();
  await page.goto('/ops');
  await expect(page.locator('#ops-event')).toHaveValue('all-open');
  const items = page.getByRole('list', { name: 'الطابور (الأقدم أولًا)' }).locator(':scope > li');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveAttribute('data-ticket', '60');
  await expect(items.nth(1)).toHaveAttribute('data-ticket', '47');

  await page.locator('#ops-event').selectOption(EVENT_ID);
  await expect(items).toHaveCount(3);
});

test('the board refreshes by polling every 15 s (until the realtime client invalidates it)', async ({
  page,
}) => {
  await page.clock.install();
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api);
  await api.install();
  await page.goto('/ops');
  const items = page.getByRole('list', { name: 'الطابور (الأقدم أولًا)' }).locator(':scope > li');
  await expect(items).toHaveCount(3);
  const board = state.board as { queue: unknown[] };
  board.queue = board.queue.slice(0, 1);
  await page.clock.runFor(16_000);
  await expect(items).toHaveCount(1);
  expect(api.callsTo('GET', `/v1/events/${EVENT_ID}/operations`).length).toBeGreaterThan(1);
});

test('no open event: the empty state, and «فتح حفل» for whoever manages events', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on('GET', `/v1/venues/${VENUE_ID}/events`, ok([]));
  await api.install();
  await page.goto('/ops');
  await expect(page.getByText('لا يوجد حفل مفتوح في هذا الموقع.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'فتح حفل' })).toBeVisible();
});
