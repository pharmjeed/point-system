import { expect, test } from '@playwright/test';
import {
  alertFixture,
  EVENT_ID,
  eventFixture,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  SAAD,
  secondsAgo,
  STAFF_USER_ID,
  VENUE_ID,
} from './support/api';
import { runOnlyAt390 } from './support/checks';
import { FakeRealtime } from './support/fake/realtime';

/**
 * The staff-gaps sweep of 02 S-01 … S-13 (docs/progress/notes/staff-gaps.md): S-05 rows with the connection and
 * «منذ» and the live update over `driver.state_changed`; S-10 custody rows with «نقل عهدة» «فتح» «فتح واقعة»;
 * S-04 «رابط التذكرة أو السائق».
 */
runOnlyAt390();

const assignment = (driverId: string) => ({
  id: `as-${driverId}`,
  driver_id: driverId,
  venue_id: VENUE_ID,
  venue_name_ar: 'قاعة ريماس',
  status: 'active',
  starts_at: secondsAgo(86400),
});

function driverRow(
  id: string,
  name: string,
  code: string,
  live: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    user: { id, employee_code: code, full_name: name, role: 'driver', status: 'active', version: 1 },
    active_assignment: assignment(id),
    live: live ? { driver: { id, full_name: name, employee_code: code }, ...live } : null,
  };
}

test('S-05: the connection of an open duty and «منذ» for an available driver; driver.state_changed re-reads the list', async ({
  page,
}) => {
  // the socket payloads are checked against the canon schemas: ids are UUIDs there
  const khalid = crypto.randomUUID();
  const saad = crypto.randomUUID();
  const fahad = crypto.randomUUID();
  let list = [
    driverRow(khalid, 'خالد العتيبي', 'D-0011', {
      driver_state: 'available',
      connection_state: 'online',
      available_since: secondsAgo(250),
    }),
    driverRow(saad, 'سعد الحربي', 'D-0042', {
      driver_state: 'busy_with_next',
      connection_state: 'uncertain',
    }),
    driverRow(fahad, 'فهد الدوسري', 'D-0007', { driver_state: 'off_duty', connection_state: 'offline' }),
  ];
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on('GET', '/v1/drivers', () => ok(list));
  const hub = FakeRealtime.standalone();
  api.realtime = hub;
  await api.install();
  await page.goto('/drivers');

  const row = (name: string) => page.getByRole('link', { name: new RegExp(name) });
  await expect(row('خالد العتيبي')).toContainText('متاح');
  await expect(row('خالد العتيبي')).toContainText(/منذ 4:\d\d/);
  await expect(row('خالد العتيبي')).toContainText('متصل');
  await expect(row('سعد الحربي')).toContainText('الاتصال غير مؤكد');
  await expect(row('سعد الحربي')).not.toContainText('منذ');
  await expect(row('فهد الدوسري')).toContainText('خارج الوردية');
  await expect(row('فهد الدوسري')).not.toContainText('متصل'); // no open duty, no connection line

  // 02 S-05 «التحديث الحي عبر driver.state_changed»
  await expect.poll(() => hub.connectedUsers()).toEqual([STAFF_USER_ID]);
  const reads = api.callsTo('GET', '/v1/drivers').length;
  list = [
    driverRow(khalid, 'خالد العتيبي', 'D-0011', { driver_state: 'retrieving', connection_state: 'online' }),
    ...list.slice(1),
  ];
  hub.emit(
    STAFF_USER_ID,
    'driver.state_changed',
    {
      driver: { id: khalid, full_name: 'خالد العتيبي' },
      driver_state: 'retrieving',
      connection_state: 'online',
    },
    { venueId: crypto.randomUUID(), aggregate: { type: 'user', id: khalid, version: null } },
  );
  await expect.poll(() => api.callsTo('GET', '/v1/drivers').length).toBeGreaterThan(reads);
  await expect(row('خالد العتيبي')).toContainText('يحضر/يسلّم');
  await expect(row('خالد العتيبي')).not.toContainText('منذ');
});

test('S-10: a key not in its slot has «نقل عهدة», «فتح» and «فتح واقعة» (key_missing)', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { event: eventFixture({ status: 'closing', version: 4 }) });
  api.on('POST', '/v1/incidents', (req) =>
    ok({ id: 'inc-9', status: 'open', ...(req.postDataJSON() as Record<string, unknown>) }, 201),
  );
  await api.install();
  await page.goto(`/events/${EVENT_ID}/close`);
  const custody = page.getByRole('region', { name: 'العهدة لدى السائقين' });
  await expect(custody).toContainText('مفتاح #39');
  await expect(custody.getByRole('button', { name: 'نقل عهدة' })).toBeVisible();

  await custody.getByRole('button', { name: 'فتح واقعة' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('#39');
  await expect(dialog.getByLabel('النوع')).toHaveValue('key_missing');
  await dialog.getByLabel('الوصف').fill('المفتاح غير موجود في اللوحة عند المطابقة');
  await dialog.getByRole('button', { name: 'تأكيد' }).click();
  await expect(dialog).toBeHidden();
  expect(api.callsTo('POST', '/v1/incidents')[0]?.body).toMatchObject({
    venue_id: VENUE_ID,
    event_id: EVENT_ID,
    ticket_id: 't-39',
    type: 'key_missing',
  });

  await custody.getByRole('button', { name: 'فتح', exact: true }).click();
  await expect(page).toHaveURL(/\/ops\/tickets\/t-39$/);
});

test('S-04: an alert about a driver (no ticket) links to the driver (S-06); a driving supervisor gets no link', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const about = (id: string, userId: string, type: string) =>
    alertFixture({
      id,
      type,
      severity: 'warning',
      ticket_id: null,
      task_id: null,
      user_id: userId,
      details: {},
    });
  mockStaffApi(api, {
    alerts: [
      alertFixture(),
      about('al-60', SAAD.id, 'driver_connection_lost_with_custody'),
      // the same alerts are raised for a supervisor with can_drive on duty (canon §10 D*): S-06 opens drivers only
      about('al-61', 'u-sup-driving', 'driver_connection_lost_with_custody'),
      about('al-62', 'u-sup-driving', 'push_failed_repeatedly'),
    ],
  });
  // `GET /v1/drivers` lists the `driver` role only
  api.on('GET', '/v1/drivers', () => ok([driverRow(SAAD.id, SAAD.full_name, SAAD.employee_code, null)]));
  await api.install();
  await page.goto('/ops/alerts');
  // a ticket alert keeps its ticket link
  await expect(page.locator('li[data-alert-id="al-47"]').getByRole('link', { name: 'فتح' })).toHaveAttribute(
    'href',
    '/ops/tickets/t-47',
  );
  await expect(page.locator('li[data-alert-id="al-60"]').getByRole('link', { name: 'فتح' })).toBeVisible();
  await expect(page.locator('li[data-alert-id="al-61"]').getByRole('link', { name: 'فتح' })).toHaveCount(0);
  await expect(page.locator('li[data-alert-id="al-62"]').getByRole('link', { name: 'فتح' })).toHaveCount(0);
  await page.locator('li[data-alert-id="al-60"]').getByRole('link', { name: 'فتح' }).click();
  await expect(page).toHaveURL(new RegExp(`/drivers/${SAAD.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SAAD.full_name);
});
