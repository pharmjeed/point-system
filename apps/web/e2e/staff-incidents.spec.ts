import { expect, test } from '@playwright/test';
import { incidentFixture, MockApi, mockStaffApi, ok, roleMe, STAFF_USER_ID, VENUE_ID } from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-12 — الوقائع (PNT-083): list and filters, «فتح واقعة», and the detail where resolving or closing needs the
 * resolution text («اكتب الحل قبل إغلاق الواقعة.»); PATCH sends `expected_version` and the changed fields.
 */
runOnlyAt390();

test('resolving an incident needs the resolution text', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api);
  let incident: Record<string, unknown> = incidentFixture();
  api.on('GET', '/v1/incidents/in-1', () => ok(incident));
  api.on('PATCH', '/v1/incidents/in-1', (req) => {
    incident = {
      ...incident,
      ...(req.postDataJSON() as object),
      version: 3,
      resolved_at: new Date().toISOString(),
    };
    state.incidents = [incident];
    return ok(incident);
  });
  await api.install();
  await page.goto('/incidents/in-1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الوقائع');
  await expect(page.getByText('خدش في الباب الخلفي الأيمن').first()).toBeVisible();

  const save = page.getByRole('button', { name: 'حفظ' });
  await expect(save).toBeDisabled();
  await page.getByLabel('نقل الحالة إلى').selectOption('resolved');
  await expect(page.locator('#incident-resolution-err')).toHaveText(/اكتب الحل قبل إغلاق الواقعة./);
  await expect(save).toBeDisabled();
  await page.getByLabel('الحل', { exact: true }).fill('تم الاتفاق مع العميل على الإصلاح');
  await page.getByRole('button', { name: 'تعييني مسؤولًا' }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('.pt-toast').filter({ hasText: 'تم تنفيذ الإجراء.' })).toBeVisible();
  const call = api.callsTo('PATCH', '/v1/incidents/in-1')[0];
  expect(call?.body).toEqual({
    expected_version: 2,
    status: 'resolved',
    owner_id: STAFF_USER_ID,
    resolution: 'تم الاتفاق مع العميل على الإصلاح',
  });
  expect(call?.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByText(/^حُلّت /)).toBeVisible();
});

test('the list filters by status and «فتح واقعة» creates one', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, {
    incidents: [
      incidentFixture(),
      incidentFixture({ id: 'in-2', type: 'key_missing', status: 'resolved', severity: 'high' }),
    ],
  });
  api.on('POST', '/v1/incidents', (req) =>
    ok(incidentFixture({ id: 'in-3', ...(req.postDataJSON() as object), version: 1 }), 201),
  );
  api.on(
    'GET',
    '/v1/incidents/in-3',
    ok(incidentFixture({ id: 'in-3', type: 'lost_ticket', ticket_id: null })),
  );
  await api.install();
  await page.goto('/incidents');
  const list = page.locator('ul.pt-list');
  await expect(list.getByRole('link')).toHaveCount(1); // open + in review by default
  await page.getByRole('group', { name: 'الحالة' }).getByRole('button', { name: 'محلولة' }).click();
  await expect(list.getByRole('link')).toHaveCount(2);
  await page.getByRole('group', { name: 'الشدة' }).getByRole('button', { name: 'عالية' }).click();
  await expect(list.getByRole('link')).toHaveCount(1);

  await page.getByRole('button', { name: 'فتح واقعة' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'فتح واقعة' });
  const confirm = dialog.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('النوع').selectOption('lost_ticket');
  await dialog.getByLabel('الوصف').fill('العميل فقد التذكرة الورقية');
  await confirm.click();
  await expect(page).toHaveURL(/\/incidents\/in-3$/);
  expect(api.callsTo('POST', '/v1/incidents')[0]?.body).toEqual({
    venue_id: VENUE_ID,
    event_id: null,
    ticket_id: null,
    type: 'lost_ticket',
    severity: 'medium',
    description: 'العميل فقد التذكرة الورقية',
  });
});

test('the owner reads incidents without the create and edit controls', async ({ page }) => {
  const api = new MockApi(page, roleMe('owner'));
  mockStaffApi(api);
  api.on('GET', '/v1/incidents/in-1', ok(incidentFixture()));
  await api.install();
  await page.goto('/incidents');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الوقائع');
  await expect(page.getByRole('button', { name: 'فتح واقعة' })).toHaveCount(0);
  await page
    .getByRole('link', { name: /تلف بالمركبة|ضرر/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/incidents\/in-1$/);
  await expect(page.getByText('خدش في الباب الخلفي الأيمن').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'حفظ' })).toHaveCount(0);
});
