import { expect, test, type Page } from '@playwright/test';
import {
  apiError,
  EVENT_ID,
  eventFixture,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  VENUE_ID,
  venueFixture,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * GAP-4 — S-08 «المواقع والحفلات» → S-10 «إغلاق الحفل والمطابقة» (02 S-08 table «بدء الإغلاق | S-10»): an open event
 * starts its closing in S-10, a closing one continues there or is reopened (`POST /v1/events/{eventId}/open`,
 * closing → open, 07; 11 §6.4), a closed one leads to its report (S-11).
 */
runOnlyAt390();

function venuePage(api: MockApi, events: Array<Record<string, unknown>>) {
  api
    .on('GET', `/v1/venues/${VENUE_ID}`, ok(venueFixture()))
    .on('GET', `/v1/venues/${VENUE_ID}/dispatch-pools`, ok([]))
    .on('GET', `/v1/venues/${VENUE_ID}/events`, ok(events));
}

const card = (page: Page) => page.getByRole('article', { name: 'حفل آل سعيد' });

test('GAP-4: S-08 event cards lead to S-10 — start the closing, continue it, reopen it; the report when closed', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api);
  venuePage(api, [eventFixture()]);
  await api.install();

  // open → «بدء الإغلاق» opens S-10 at step 1 (its Dialog sends start-closing)
  await page.goto(`/venues/${VENUE_ID}`);
  await card(page).getByRole('button', { name: 'بدء الإغلاق' }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${EVENT_ID}/close$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('إغلاق الحفل · حفل آل سعيد');
  await expect(page.getByRole('button', { name: 'بدء الإغلاق' })).toBeVisible();
  await page.getByRole('button', { name: 'رجوع' }).click();
  await expect(page).toHaveURL(new RegExp(`/venues/${VENUE_ID}$`));

  // closing → «إغلاق الحفل والمطابقة» and «إعادة فتح الحفل» (closing → open, 07 openEvent)
  const closing = eventFixture({ status: 'closing', version: 4 });
  state.event = closing;
  venuePage(api, [closing]);
  api.on('POST', `/v1/events/${EVENT_ID}/open`, () => {
    venuePage(api, [eventFixture({ status: 'open', version: 5 })]);
    return ok(eventFixture({ status: 'open', version: 5 }));
  });
  await page.reload();
  await expect(card(page).getByRole('button', { name: 'بدء الإغلاق' })).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'تعديل' })).toHaveCount(0);
  await card(page).getByRole('button', { name: 'إغلاق الحفل والمطابقة' }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${EVENT_ID}/close$`));
  await expect(page.getByRole('button', { name: 'إغلاق الحفل' })).toBeVisible();
  await page.getByRole('button', { name: 'رجوع' }).click();
  await card(page).getByRole('button', { name: 'إعادة فتح الحفل' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إعادة فتح الحفل' });
  await expect(dialog).toContainText('يعود الحفل «مفتوحًا» ويُسمح بتسجيل مركبات جديدة فيه.');
  expect(api.callsTo('POST', `/v1/events/${EVENT_ID}/open`)).toHaveLength(0);
  await dialog.getByRole('button', { name: 'إعادة فتح الحفل' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page).getByRole('button', { name: 'بدء الإغلاق' })).toBeVisible();
  const call = api.callsTo('POST', `/v1/events/${EVENT_ID}/open`)[0];
  expect(call?.body).toEqual({ expected_version: 4 });
  expect(call?.headers['idempotency-key']).toBeTruthy();

  // closed → «عرض التقرير» (S-11 of the event)
  venuePage(api, [eventFixture({ status: 'closed', version: 6 })]);
  api.on('GET', '/v1/reports/events/e-rms-1/summary', apiError('RESOURCE_NOT_FOUND', 404));
  await page.reload();
  await page.getByRole('radio', { name: 'المغلقة' }).click();
  await card(page).getByRole('button', { name: 'عرض التقرير' }).click();
  await expect(page).toHaveURL(new RegExp(`/reports\\?event=${EVENT_ID}$`));
});

test('GAP-4: a refused reopen stays in its Dialog; no S-10 way for whoever lacks event.manage', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { event: eventFixture({ status: 'closing', version: 4 }) });
  venuePage(api, [eventFixture({ status: 'closing', version: 4 })]);
  api.on('POST', `/v1/events/${EVENT_ID}/open`, apiError('EVENT_ALREADY_CLOSED', 409));
  await api.install();
  await page.goto(`/venues/${VENUE_ID}`);
  await card(page).getByRole('button', { name: 'إعادة فتح الحفل' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إعادة فتح الحفل' });
  await dialog.getByRole('button', { name: 'إعادة فتح الحفل' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toBeVisible();

  api.me = roleMe('supervisor', { remove: ['event.manage'] });
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole('button')).toHaveCount(0);
});
