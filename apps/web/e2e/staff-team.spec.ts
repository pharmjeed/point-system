import { expect, test, type Page } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import {
  apiError,
  MockApi,
  mockStaffApi,
  OTHER_VENUE_ID,
  ok,
  roleMe,
  secondsAgo,
  VENUE_ID,
} from './support/api';
import { browserStorageDump, runOnlyAt390 } from './support/checks';

/**
 * GAP-3 — S-13 «الموظفون» (02 S-13; 07 §2.6; canon §10 `staff.manage`): the administration manages supervisors
 * only, the owner manages the administration too and alone resets MFA. Every command carries an Idempotency-Key;
 * the temporary password is shown once and never stored.
 */
runOnlyAt390();

const SUP = {
  user: {
    id: 'u-sup-rim',
    employee_code: 'S-0003',
    full_name: 'ريم الشهري',
    phone_e164: '+966551110003',
    phone_masked: '05•••••003',
    role: 'supervisor',
    can_drive: false,
    status: 'active',
    mfa_enabled: true,
    must_change_secret: false,
    last_login_at: secondsAgo(3600),
    version: 2,
  },
  scopes: [{ id: 'rs-1', scope_type: 'venue', venue_id: VENUE_ID, granted_at: secondsAgo(86400) }],
};
const ADM = {
  user: {
    id: 'u-adm-sara',
    employee_code: 'A-0002',
    full_name: 'سارة العنزي',
    phone_e164: '+966551110002',
    phone_masked: '05•••••002',
    role: 'admin',
    can_drive: false,
    status: 'active',
    mfa_enabled: true,
    must_change_secret: false,
    last_login_at: null,
    version: 1,
  },
  scopes: [{ id: 'rs-2', scope_type: 'org', venue_id: null, granted_at: secondsAgo(86400) }],
};

function staffApi(api: MockApi, members: unknown[]) {
  mockStaffApi(api);
  api.on('GET', '/v1/staff', () => ok(members));
  return api;
}

const row = (page: Page, name: string) =>
  page.locator('.pt-table-cards li').filter({ hasText: name }).filter({ visible: true });

test('the owner sees the administration and the supervisors, adds an admin and sees the password once', async ({
  page,
}) => {
  const api = staffApi(new MockApi(page, roleMe('owner')), [SUP, ADM]);
  api.on('POST', '/v1/staff', () =>
    ok(
      {
        user: {
          ...ADM.user,
          id: 'u-new',
          full_name: 'هند المطيري',
          employee_code: 'A-0003',
          mfa_enabled: false,
        },
        temporary_secret: 'Tmp-7Q2w-9Lk3',
      },
      201,
    ),
  );
  await api.install();
  await page.goto('/admin');
  await page.getByRole('link', { name: 'الموظفون' }).click();
  await expect(page).toHaveURL(/\/admin\/staff$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الموظفون');
  await expect(row(page, 'سارة العنزي')).toContainText('الإدارة');
  await expect(row(page, 'سارة العنزي')).toContainText('كل المواقع');
  await expect(row(page, 'ريم الشهري')).toContainText('قاعة ريماس');
  await expect(row(page, 'ريم الشهري')).toContainText('مفعّل');

  await page.getByRole('button', { name: 'إضافة موظف' }).click();
  const sheet = page.getByRole('dialog', { name: 'إضافة موظف' });
  await sheet.getByLabel('الاسم الكامل').fill('هند المطيري');
  await sheet.getByLabel('رقم الجوال').fill('0551110009');
  await sheet.getByRole('radio', { name: 'الإدارة' }).check();
  // the administration works on every venue: no venue list, no «يسمح بالقيادة» (supervisors only)
  await expect(sheet.getByLabel('يسمح بالقيادة')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'إضافة موظف' }).click();
  const secret = page.getByRole('alertdialog', { name: 'هند المطيري' });
  await expect(secret).toContainText('كلمة المرور المؤقتة: Tmp-7Q2w-9Lk3.');
  const call = api.callsTo('POST', '/v1/staff')[0];
  expect(call?.body).toEqual({ full_name: 'هند المطيري', phone: '+966551110009', role: 'admin' });
  expect(call?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(await browserStorageDump(page)).not.toContain('Tmp-7Q2w-9Lk3');
  await secret.getByRole('button', { name: 'فهمت' }).click();
  await expect(page.getByText('Tmp-7Q2w-9Lk3')).toHaveCount(0);
});

test('the administration adds a supervisor with «يسمح بالقيادة» and venues; a duplicate phone is under the field', async ({
  page,
}) => {
  const api = staffApi(new MockApi(page, roleMe('admin')), [SUP]);
  api.sequence('POST', '/v1/staff', [
    apiError('VALIDATION_FAILED', 422, {
      details: {
        fields: [{ field: 'phone', issue: 'duplicate', message_ar: 'هذا الرقم مستخدم لحساب آخر.' }],
      },
    }),
    ok(
      {
        user: { ...SUP.user, id: 'u-new', full_name: 'بدر القرني', employee_code: 'S-0009' },
        temporary_secret: 'Tmp-1Ab2',
      },
      201,
    ),
  ]);
  await api.install();
  await page.goto('/admin/staff');
  await expect(row(page, 'ريم الشهري')).toBeVisible();
  // the administration does not see the role choice (supervisors only) nor the role filter
  await expect(page.getByRole('group', { name: 'الدور' })).toHaveCount(0);
  await page.getByRole('button', { name: 'إضافة موظف' }).click();
  const sheet = page.getByRole('dialog', { name: 'إضافة موظف' });
  await expect(sheet.getByRole('radio', { name: 'الإدارة' })).toHaveCount(0);
  await expect(sheet.getByText('الدور: مشرف')).toBeVisible();
  await sheet.getByLabel('الاسم الكامل').fill('بدر القرني');
  await sheet.getByLabel('رقم الجوال').fill('0551110003');
  await sheet.getByLabel('يسمح بالقيادة').check();
  await sheet.getByLabel('قاعة ريماس').check();
  await sheet.getByLabel('قاعة ليالي').check();
  await sheet.getByRole('button', { name: 'إضافة موظف' }).click();
  await expect(sheet.getByText('هذا الرقم مستخدم لحساب آخر.')).toBeVisible();
  await sheet.getByLabel('رقم الجوال').fill('0551110010');
  await sheet.getByRole('button', { name: 'إضافة موظف' }).click();
  await expect(page.getByRole('alertdialog', { name: 'بدر القرني' })).toContainText('Tmp-1Ab2');
  const calls = api.callsTo('POST', '/v1/staff');
  expect(calls[1]?.body).toEqual({
    full_name: 'بدر القرني',
    phone: '+966551110010',
    role: 'supervisor',
    can_drive: true,
    venue_ids: [VENUE_ID, OTHER_VENUE_ID],
  });
});

test('edit, scopes, disable (CUSTODY_OPEN lists the items) and enable — each with its reason and key', async ({
  page,
}) => {
  const api = staffApi(new MockApi(page, roleMe('admin')), [SUP]);
  api.on('PATCH', `/v1/staff/${SUP.user.id}`, (req) => {
    const body = req.postDataJSON() as { status?: string };
    if (body.status === 'disabled')
      return apiError('CUSTODY_OPEN', 409, {
        details: { items: [{ type: 'key', ticket_id: 't-39', display_number: 39 }] },
      });
    return ok({ ...SUP.user, version: 3 });
  });
  api.on('POST', `/v1/staff/${SUP.user.id}/scopes`, () =>
    ok([{ id: 'rs-3', scope_type: 'venue', venue_id: OTHER_VENUE_ID, granted_at: secondsAgo(1) }]),
  );
  await api.install();
  await page.goto('/admin/staff');
  const open = async () => {
    await row(page, 'ريم الشهري').getByRole('button', { name: 'الإجراءات' }).click();
    return page.getByRole('dialog', { name: 'ريم الشهري' });
  };
  // the administration never resets MFA (owner only, 09 §9.1)
  let member = await open();
  await expect(member.getByRole('button', { name: 'إعادة ضبط التحقق الثنائي' })).toHaveCount(0);

  await member.getByRole('button', { name: 'تعديل البيانات' }).click();
  const edit = page.getByRole('dialog', { name: 'تعديل البيانات' });
  await edit.getByLabel('الاسم الكامل').fill('ريم سعد الشهري');
  await edit.getByLabel('يسمح بالقيادة').check();
  await edit.getByRole('button', { name: 'حفظ' }).click();
  await expect(edit).toBeHidden();
  expect(api.callsTo('PATCH', `/v1/staff/${SUP.user.id}`)[0]?.body).toEqual({
    expected_version: 2,
    full_name: 'ريم سعد الشهري',
    can_drive: true,
  });

  member = await open();
  await member.getByRole('button', { name: 'النطاقات' }).click();
  const scopes = page.getByRole('dialog', { name: 'النطاقات · ريم الشهري' });
  await expect(scopes.getByLabel('قاعة ريماس')).toBeChecked();
  await scopes.getByLabel('قاعة ريماس').uncheck();
  await scopes.getByLabel('قاعة ليالي').check();
  await scopes.getByRole('button', { name: 'حفظ' }).click();
  await expect(scopes).toBeHidden();
  const scopeCall = api.callsTo('POST', `/v1/staff/${SUP.user.id}/scopes`)[0];
  expect(scopeCall?.body).toEqual({ grant_venue_ids: [OTHER_VENUE_ID], revoke_venue_ids: [VENUE_ID] });
  expect(scopeCall?.headers['idempotency-key']).toBeTruthy();

  member = await open();
  await member.getByRole('button', { name: 'تعطيل الحساب' }).click();
  const disable = page.getByRole('alertdialog', { name: 'تعطيل الحساب' });
  await expect(disable.getByRole('button', { name: 'تعطيل الحساب' })).toBeDisabled();
  await disable.getByLabel('السبب (إلزامي)').fill('انتهى عقده مع الموقع');
  await disable.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(disable).toContainText('مفتاح');
  await expect(disable).toContainText('#39');
  expect(api.callsTo('PATCH', `/v1/staff/${SUP.user.id}`)[1]?.body).toEqual({
    expected_version: 2,
    status: 'disabled',
    reason: 'انتهى عقده مع الموقع',
  });
});

test('the owner resets MFA with a reason; an enabled account is offered «تفعيل الحساب»', async ({ page }) => {
  const disabled = {
    ...SUP,
    user: { ...SUP.user, id: 'u-sup-off', full_name: 'خالد العمري', status: 'disabled' },
  };
  const api = staffApi(new MockApi(page, roleMe('owner')), [ADM, disabled]);
  api.on('POST', `/v1/staff/${ADM.user.id}/reset-mfa`, () =>
    ok({ ...ADM.user, mfa_enabled: false, version: 2 }),
  );
  api.on('PATCH', `/v1/staff/${disabled.user.id}`, () =>
    ok({ ...disabled.user, status: 'active', version: 3 }),
  );
  await api.install();
  await page.goto('/admin/staff');
  await row(page, 'سارة العنزي').getByRole('button', { name: 'الإجراءات' }).click();
  await page
    .getByRole('dialog', { name: 'سارة العنزي' })
    .getByRole('button', { name: 'إعادة ضبط التحقق الثنائي' })
    .click();
  const reset = page.getByRole('alertdialog', { name: 'إعادة ضبط التحقق الثنائي' });
  await expect(reset).toContainText('إعادة ضبط التحقق الثنائي لـسارة العنزي؟');
  await reset.getByLabel('السبب (إلزامي)').fill('فقدت جهاز المصادقة');
  await reset.getByRole('button', { name: 'إعادة ضبط التحقق الثنائي' }).click();
  await expect(reset).toBeHidden();
  const call = api.callsTo('POST', `/v1/staff/${ADM.user.id}/reset-mfa`)[0];
  expect(call?.body).toEqual({ reason: 'فقدت جهاز المصادقة' });
  expect(call?.headers['idempotency-key']).toBeTruthy();

  await row(page, 'خالد العمري').getByRole('button', { name: 'الإجراءات' }).click();
  await page
    .getByRole('dialog', { name: 'خالد العمري' })
    .getByRole('button', { name: 'تفعيل الحساب' })
    .click();
  const enable = page.getByRole('alertdialog', { name: 'تفعيل الحساب' });
  await enable.getByLabel('السبب (إلزامي)').fill('عاد للعمل');
  await enable.getByRole('button', { name: 'تفعيل الحساب' }).click();
  await expect(enable).toBeHidden();
  expect(api.callsTo('PATCH', `/v1/staff/${disabled.user.id}`)[0]?.body).toEqual({
    expected_version: 2,
    status: 'active',
    reason: 'عاد للعمل',
  });
});

test('a refused command shows the server text; a supervisor has no «الموظفون»', async ({ page }) => {
  const api = staffApi(new MockApi(page, roleMe('admin')), [SUP]);
  const refusal = 'الإدارة تدير المشرفين فقط.';
  api.on('PATCH', `/v1/staff/${SUP.user.id}`, apiError('PERMISSION_DENIED', 403, { message_ar: refusal }));
  await api.install();
  await page.goto('/admin/staff');
  await row(page, 'ريم الشهري').getByRole('button', { name: 'الإجراءات' }).click();
  await page
    .getByRole('dialog', { name: 'ريم الشهري' })
    .getByRole('button', { name: 'تعطيل الحساب' })
    .click();
  const disable = page.getByRole('alertdialog', { name: 'تعطيل الحساب' });
  await disable.getByLabel('السبب (إلزامي)').fill('اختبار الرفض');
  await disable.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(page.locator('.pt-toast').filter({ hasText: refusal })).toBeVisible();
  await expect(disable).toBeHidden();

  api.me = roleMe('supervisor');
  const before = api.callsTo('GET', '/v1/staff').length;
  await page.goto('/admin/staff');
  await expect(page.getByText('لا تملك صلاحية عرض هذه الصفحة.')).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByText('لا تملك صلاحية عرض هذه الصفحة.')).toBeVisible();
  expect(api.callsTo('GET', '/v1/staff')).toHaveLength(before); // the list is never read for a supervisor
});

test('VERSION_CONFLICT re-reads the list: the next «حفظ» keeps the inputs and sends the new version', async ({
  page,
}) => {
  // users.version moves on outside this screen (the first sign-in, another admin): the list has no realtime
  let version = 2;
  const api = staffApi(new MockApi(page, roleMe('admin')), []);
  api.on('GET', '/v1/staff', () => ok([{ ...SUP, user: { ...SUP.user, version } }]));
  api.on('PATCH', `/v1/staff/${SUP.user.id}`, (req) => {
    const body = req.postDataJSON() as { expected_version: number; status?: string };
    if (body.expected_version !== version)
      return apiError('VERSION_CONFLICT', 409, { details: { current_version: version } });
    version += 1;
    return ok({ ...SUP.user, ...(body.status ? { status: body.status } : {}), version });
  });
  await api.install();
  await page.goto('/admin/staff');
  await expect(row(page, 'ريم الشهري')).toBeVisible();
  version = 3;
  await row(page, 'ريم الشهري').getByRole('button', { name: 'الإجراءات' }).click();
  await page
    .getByRole('dialog', { name: 'ريم الشهري' })
    .getByRole('button', { name: 'تعديل البيانات' })
    .click();
  const edit = page.getByRole('dialog', { name: 'تعديل البيانات' });
  await edit.getByLabel('الاسم الكامل').fill('ريم سعد الشهري');
  const reads = api.callsTo('GET', '/v1/staff').length;
  await edit.getByRole('button', { name: 'حفظ' }).click();
  await expect(edit.getByText(errorMessagesAr.VERSION_CONFLICT)).toBeVisible();
  await expect.poll(() => api.callsTo('GET', '/v1/staff').length).toBeGreaterThan(reads);
  await expect(edit.getByLabel('الاسم الكامل')).toHaveValue('ريم سعد الشهري');
  await edit.getByRole('button', { name: 'حفظ' }).click();
  await expect(edit).toBeHidden();
  const edits = api.callsTo('PATCH', `/v1/staff/${SUP.user.id}`);
  expect(edits.map((c) => c.body)).toEqual([
    { expected_version: 2, full_name: 'ريم سعد الشهري' },
    { expected_version: 3, full_name: 'ريم سعد الشهري' },
  ]);
  expect(edits[1]?.headers['idempotency-key']).not.toBe(edits[0]?.headers['idempotency-key']);

  // the same for «تعطيل الحساب»: the reason stays, the retry carries the re-read version
  await expect.poll(() => api.callsTo('GET', '/v1/staff').length).toBeGreaterThan(reads + 1);
  version = 5;
  await row(page, 'ريم الشهري').getByRole('button', { name: 'الإجراءات' }).click();
  await page
    .getByRole('dialog', { name: 'ريم الشهري' })
    .getByRole('button', { name: 'تعطيل الحساب' })
    .click();
  const disable = page.getByRole('alertdialog', { name: 'تعطيل الحساب' });
  await disable.getByLabel('السبب (إلزامي)').fill('انتهى عقده مع الموقع');
  const before = api.callsTo('GET', '/v1/staff').length;
  await disable.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(disable.getByText(errorMessagesAr.VERSION_CONFLICT)).toBeVisible();
  await expect.poll(() => api.callsTo('GET', '/v1/staff').length).toBeGreaterThan(before);
  await expect(disable.getByLabel('السبب (إلزامي)')).toHaveValue('انتهى عقده مع الموقع');
  await disable.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(disable).toBeHidden();
  expect(
    api
      .callsTo('PATCH', `/v1/staff/${SUP.user.id}`)
      .map((c) => c.body)
      .slice(2),
  ).toEqual([
    { expected_version: 4, status: 'disabled', reason: 'انتهى عقده مع الموقع' },
    { expected_version: 5, status: 'disabled', reason: 'انتهى عقده مع الموقع' },
  ]);
});

test('the owner withdraws and restores the org scope of an administration account («النطاقات»)', async ({
  page,
}) => {
  let scopes: unknown[] = ADM.scopes;
  const api = staffApi(new MockApi(page, roleMe('owner')), []);
  api.on('GET', '/v1/staff', () => ok([{ ...ADM, scopes }]));
  api.on('POST', `/v1/staff/${ADM.user.id}/scopes`, (req) => {
    const body = req.postDataJSON() as { org_scope?: boolean };
    scopes = body.org_scope ? ADM.scopes : [];
    return ok(scopes);
  });
  await api.install();
  await page.goto('/admin/staff');
  await expect(row(page, 'سارة العنزي')).toContainText('كل المواقع');
  const openScopes = async () => {
    await row(page, 'سارة العنزي').getByRole('button', { name: 'الإجراءات' }).click();
    await page.getByRole('dialog', { name: 'سارة العنزي' }).getByRole('button', { name: 'النطاقات' }).click();
    return page.getByRole('dialog', { name: 'النطاقات · سارة العنزي' });
  };
  let sheet = await openScopes();
  const save = sheet.getByRole('button', { name: 'حفظ' });
  // nothing changed yet: «حفظ» stays disabled; an administration account has no venue list
  await expect(sheet.getByLabel('كل المواقع')).toBeChecked();
  await expect(sheet.getByLabel('قاعة ريماس')).toHaveCount(0);
  await expect(save).toBeDisabled();
  await sheet.getByLabel('كل المواقع').uncheck();
  await expect(save).toBeEnabled();
  await sheet.getByLabel('كل المواقع').check();
  await expect(save).toBeDisabled();
  await sheet.getByLabel('كل المواقع').uncheck();
  await save.click();
  await expect(sheet).toBeHidden();
  await expect(row(page, 'سارة العنزي')).toContainText('بلا نطاق');

  sheet = await openScopes();
  await expect(sheet.getByLabel('كل المواقع')).not.toBeChecked();
  await sheet.getByLabel('كل المواقع').check();
  await sheet.getByRole('button', { name: 'حفظ' }).click();
  await expect(sheet).toBeHidden();
  await expect(row(page, 'سارة العنزي')).toContainText('كل المواقع');
  const calls = api.callsTo('POST', `/v1/staff/${ADM.user.id}/scopes`);
  expect(calls.map((c) => c.body)).toEqual([{ org_scope: false }, { org_scope: true }]);
  for (const c of calls) expect(c.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[0]?.headers['idempotency-key']).not.toBe(calls[1]?.headers['idempotency-key']);
});
