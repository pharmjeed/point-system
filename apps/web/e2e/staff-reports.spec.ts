import { expect, test } from '@playwright/test';
import {
  apiError,
  EVENT_ID,
  eventFixture,
  KHALID,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  SAAD,
  VENUE_ID,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-11 — التقارير والتصدير (PNT-088/089): the period is Riyadh days sent as UTC, the four cards, and «تصدير CSV»
 * (audited) polled until the temporary download link is ready.
 */
runOnlyAt390();

/** The query of every `GET /v1/reports/payments` of the last `mockReports`. */
let paymentQueries: URLSearchParams[] = [];

/** Registers the report reads; returns the query of every `GET /v1/reports/drivers`. */
function mockReports(api: MockApi): URLSearchParams[] {
  const driverQueries: URLSearchParams[] = [];
  paymentQueries = [];
  const drivers = ok([
    {
      driver: KHALID,
      duty_hours: 6.5,
      parked: 21,
      retrieved: 18,
      delivered: 18,
      offers_expired: 1,
      accept_p50_s: 14,
    },
    {
      driver: SAAD,
      duty_hours: 6,
      parked: 17,
      retrieved: 20,
      delivered: 19,
      offers_expired: 0,
      accept_p50_s: 22,
    },
  ]);
  api
    .on('GET', '/v1/reports/drivers', (req) => {
      driverQueries.push(new URL(req.url()).searchParams);
      return drivers;
    })
    .on(
      'GET',
      `/v1/venues/${VENUE_ID}/events`,
      ok([eventFixture(), eventFixture({ id: 'e-old', name_ar: 'حفل آل ناصر', status: 'closed' })]),
    )
    .on('GET', '/v1/reports/payments', (req) => {
      const query = new URL(req.url()).searchParams;
      paymentQueries.push(query);
      // the server's strict query (07 getPaymentsReport): from and to are required (contract:F6)
      const missing = ['from', 'to'].filter((k) => !query.get(k));
      if (missing.length)
        return apiError('VALIDATION_FAILED', 422, {
          details: { fields: missing.map((field) => ({ field, issue: 'invalid_type' })) },
        });
      return ok({
        from: query.get('from'),
        to: query.get('to'),
        totals: { cash_halalas: 50000, pos_halalas: 40000, waived: 1, reversed: 0, outstanding: 1 },
        rows: [],
      });
    })
    .on(
      'GET',
      '/v1/reports/messages',
      ok({
        from: '',
        to: '',
        totals: { sent: 120, delivered: 115, read: 98, failed: 3 },
        failures: [
          {
            id: 'f1',
            direction: 'outbound',
            kind: 'template',
            status: 'failed',
            status_rank: 9,
            error_title: 'Message undeliverable',
          },
          {
            id: 'f2',
            direction: 'outbound',
            kind: 'template',
            status: 'failed',
            status_rank: 9,
            error_title: 'Message undeliverable',
          },
          {
            id: 'f3',
            direction: 'outbound',
            kind: 'template',
            status: 'failed',
            status_rank: 9,
            error_title: 'Rate limit hit',
          },
        ],
      }),
    )
    .on(
      'GET',
      `/v1/reports/events/${EVENT_ID}/summary`,
      ok({
        event: eventFixture(),
        counts: { tickets_total: 40, delivered: 37, open: 2, voided: 1, reparks: 2, canceled_requests: 3 },
        timings_seconds: {
          accept: { p50: 18, p90: 55 },
          start: { p50: 40, p90: 95 },
          request_to_ready: { p50: 260, p90: 480 },
          ready_to_delivered: { p50: 70, p90: 210 },
        },
        offers: {},
        messages: {},
        payments: {},
        incidents: {},
        by_driver: [],
      }),
    );
  return driverQueries;
}

test('cards follow the filters; the period goes as Riyadh days in UTC', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  const driverQueries = mockReports(api);
  await api.install();
  await page.goto('/reports');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('التقارير والتصدير');
  await expect(page.getByText('اختر حفلًا لعرض ملخصه.')).toBeVisible();

  const drivers = page.getByRole('region', { name: 'أداء السائقين' });
  await expect(drivers).toContainText('خالد العتيبي');
  await expect(drivers).toContainText('سعد الحربي');
  const messages = page.getByRole('region', { name: 'الرسائل', exact: true });
  await expect(messages).toContainText('Message undeliverable');
  await expect(messages).toContainText('Rate limit hit');
  await expect(page.getByRole('region', { name: 'التحصيل' })).toContainText('500.00');

  await page.locator('#reports-from').fill('2026-10-01');
  await page.locator('#reports-to').fill('2026-10-07');
  await expect.poll(() => driverQueries.at(-1)?.get('to')).toBe('2026-10-07T21:00:00.000Z');
  const q = driverQueries.at(-1);
  expect(q?.get('from')).toBe('2026-09-30T21:00:00.000Z');
  expect(q?.get('venue_id')).toBe(VENUE_ID);

  await page.locator('#reports-to').fill('2026-09-01');
  await expect(page.getByText('اختر فترة صحيحة: «من» لا يتجاوز «إلى».')).toBeVisible();

  await page.locator('#reports-event').selectOption(EVENT_ID);
  const summary = page.getByRole('region', { name: 'ملخص الحفل' });
  await expect(summary).toContainText('40');
  await expect(summary).toContainText('الدورات الملغاة (منفصلة)');
  await expect(summary).toContainText('p90 0:55');
  // contract:F6: with the period invalid, the chosen event's Riyadh day is the payments period (DEC-288)
  const payments = page.getByRole('region', { name: 'التحصيل' });
  await expect.poll(() => paymentQueries.at(-1)?.get('event_id')).toBe(EVENT_ID);
  const day = eventFixture().event_date;
  const pq = paymentQueries.at(-1);
  expect(pq?.get('from')).toBe(new Date(Date.parse(`${day}T00:00:00+03:00`)).toISOString());
  expect(pq?.get('to')).toBe(new Date(Date.parse(`${day}T00:00:00+03:00`) + 86_400_000).toISOString());
  await expect(payments).toContainText('500.00');
  await expect(payments).not.toContainText('تحقّق من الحقول المحددة.');
  // no event and an invalid period: the card waits for a valid period, nothing is asked
  await page.locator('#reports-event').selectOption('');
  const asked = paymentQueries.length;
  await expect(payments).not.toContainText('تحقّق من الحقول المحددة.');
  expect(paymentQueries.slice(asked).every((q) => q.get('from') && q.get('to'))).toBe(true);
  expect(paymentQueries.every((q) => q.get('from') && q.get('to'))).toBe(true);
});

test('«تصدير CSV» posts the export, then polls until the download link is ready', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  mockReports(api);
  const job = { id: 'ex-1', kind: 'event_summary', status: 'pending', created_at: new Date().toISOString() };
  api.on('POST', '/v1/exports', ok(job, 202));
  api.sequence('GET', '/v1/exports/ex-1', [
    ok({ ...job, status: 'running' }),
    ok({ ...job, status: 'ready', row_count: 40, download_url: '/downloads/ex-1.csv' }),
  ]);
  await api.install();
  await page.goto(`/reports?event=${EVENT_ID}`);
  await page.getByRole('button', { name: 'تصدير CSV' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'تصدير CSV' });
  await expect(dialog).toContainText('يُسجّل التصدير في سجل التدقيق.');
  await expect(dialog.getByLabel('نوع التصدير')).toHaveValue('event_summary');
  await dialog.getByRole('button', { name: 'تأكيد' }).click();
  await expect(dialog).toContainText('جارٍ التجهيز…');
  const download = dialog.getByRole('link', { name: 'تنزيل' });
  await expect(download).toBeVisible({ timeout: 8000 });
  await expect(download).toHaveAttribute('href', '/downloads/ex-1.csv');
  const post = api.callsTo('POST', '/v1/exports')[0];
  expect(post?.body).toEqual({ kind: 'event_summary', filters: { venue_id: VENUE_ID, event_id: EVENT_ID } });
  expect(post?.headers['idempotency-key']).toBeTruthy();
  expect(api.callsTo('GET', '/v1/exports/ex-1').length).toBeGreaterThanOrEqual(2);
});
