import { expect, test, type Page } from '@playwright/test';
import { MockApi, mockStaffApi, ok, roleMe, VENUE_ID } from './support/api';
import { expectMobileLayout } from './support/checks';

/**
 * V2-004 — the venue public profile: S-13 «ملف الموقع العام» (O-04) and the platform console's P-04, Arabic RTL at
 * 360/390/430 px (layout at every width; the flows at every width too, they are short).
 */

const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const profile = (over: Record<string, unknown> = {}) => ({
  venue_id: VENUE_ID,
  venue: { code: 'RMS', name_ar: 'قاعة ريماس', name_en: null, status: 'active' },
  status: 'draft',
  category: 'mall',
  address: 'طريق الملك فهد، العليا',
  city: 'الرياض',
  lat: 24.7136,
  lng: 46.6753,
  opening_hours: {
    always_open: false,
    days: { sun: [{ open: '08:00', close: '22:00' }], fri: [{ open: '20:00', close: '02:00' }] },
  },
  photos: [{ id: 'ph-1', url: PHOTO, expires_at: new Date(Date.now() + 300_000).toISOString() }],
  subscriptions_enabled: true,
  pay_per_visit_halalas: 2000,
  approved_at: null,
  review_note: { kind: 'sent_back', reason: 'الصورة غير واضحة', at: new Date().toISOString() },
  version: 3,
  updated_at: new Date().toISOString(),
  ...over,
});

test('S-13 «ملف الموقع العام»: the reviewer’s note, the form, save as draft then submit', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('owner'));
  mockStaffApi(api);
  let current = profile();
  api.on('GET', `/v1/venues/${VENUE_ID}/public-profile`, () => ok(current));
  api.on('PUT', `/v1/venues/${VENUE_ID}/public-profile`, () => {
    current = profile({ version: 4, city: 'جدة' });
    return ok(current);
  });
  api.on('POST', `/v1/venues/${VENUE_ID}/public-profile/submit`, () => {
    current = profile({ version: 5, city: 'جدة', status: 'submitted', review_note: null });
    return ok(current);
  });
  await api.install();
  await page.goto('/admin/listing');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ملف الموقع العام');
  await expect(page.getByText('أعادته المنصة للتعديل: الصورة غير واضحة')).toBeVisible();
  await expect(page.locator('#listing-address')).toHaveValue('طريق الملك فهد، العليا');
  await expect(page.locator('#listing-fri-0-close')).toHaveValue('02:00');
  await expect(page.getByText('20 ريال')).toBeVisible(); // the platform's price, read-only
  await expectMobileLayout(page);

  const submit = page.getByRole('button', { name: 'إرسال للمراجعة' });
  await page.locator('#listing-city').fill('جدة');
  await expect(submit).toBeDisabled(); // unsaved changes first
  await page.getByRole('button', { name: 'حفظ المسودة' }).click();
  await expect(page.locator('.pt-toast').filter({ hasText: 'حُفظت المسودة.' })).toBeVisible();
  const put = api.callsTo('PUT', `/v1/venues/${VENUE_ID}/public-profile`)[0]!;
  expect(put.headers['idempotency-key']).toBeTruthy();
  expect(put.body).toMatchObject({
    expected_version: 3,
    category: 'mall',
    city: 'جدة',
    lat: 24.7136,
    photo_ids: ['ph-1'],
    opening_hours: { always_open: false, days: { fri: [{ open: '20:00', close: '02:00' }] } },
  });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId('listing-status')).toHaveText('بانتظار المراجعة');
  expect(api.callsTo('POST', `/v1/venues/${VENUE_ID}/public-profile/submit`)[0]?.body).toEqual({
    expected_version: 4,
  });
  await expectMobileLayout(page);
});

test('S-13: a profile hidden by the platform is read-only with its reason', async ({ page }) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on('GET', `/v1/venues/${VENUE_ID}/public-profile`, () =>
    ok(
      profile({
        status: 'hidden',
        review_note: { kind: 'hidden', reason: 'شكوى', at: new Date().toISOString() },
      }),
    ),
  );
  await api.install();
  await page.goto('/admin/listing');
  await expect(page.getByText('أخفت المنصة هذا الملف. تواصل مع المنصة لإظهاره.')).toBeVisible();
  await expect(page.getByText('سبب الإخفاء: شكوى')).toBeVisible();
  await expect(page.getByRole('button', { name: 'حفظ المسودة' })).toHaveCount(0);
  await expect(page.locator('#listing-address')).toBeDisabled();
  await expectMobileLayout(page);
});

const platformMe = (role: string, permissions: string[]) => ({
  user: {
    id: 'pu-1',
    full_name: 'إدارة المنصة',
    phone_masked: '05•••••002',
    role,
    status: 'active',
    mfa_enabled: true,
    must_change_secret: false,
  },
  permissions: ['platform.self', 'platform.overview_read', ...permissions],
  session: {
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    mfa_verified: true,
    restricted: false,
    pending: [],
  },
  brand: { staff_name_ar: 'S', staff_name_en: 'S' },
});

async function platformApi(page: Page, me: ReturnType<typeof platformMe>) {
  const api = new MockApi(page, null);
  let current = {
    ...profile({ status: 'submitted', review_note: null }),
    org: { id: 'org-a', name_ar: 'المشغل الأول', name_en: null, operator_status: 'active' },
    approved_by: null,
  };
  api.on('GET', '/v1/platform/me', () => ok(me));
  api.on('GET', '/v1/platform/venues', () =>
    ok([
      {
        venue_id: VENUE_ID,
        venue: { code: 'RMS', name_ar: 'قاعة ريماس', status: 'active' },
        org: { id: 'org-a', name_ar: 'المشغل الأول', operator_status: 'active' },
        status: 'submitted',
        category: 'mall',
        city: 'الرياض',
        photo_count: 1,
        subscriptions_enabled: true,
        pay_per_visit_halalas: 2000,
        version: 3,
        updated_at: new Date().toISOString(),
      },
    ]),
  );
  api.on('GET', `/v1/platform/venues/${VENUE_ID}`, () => ok(current));
  api.on('POST', `/v1/platform/venues/${VENUE_ID}/send-back`, () => {
    current = { ...current, status: 'draft', version: 4 };
    return ok(current);
  });
  await api.install();
  return api;
}

test('P-04: the submissions list, the profile and «send back» with a mandatory reason', async ({ page }) => {
  const api = await platformApi(page, platformMe('platform_admin', ['platform.venue_review']));
  await page.goto('/platform');
  await page.getByRole('link', { name: 'طلبات إدراج المواقع' }).click();
  await expect(page.getByText('قاعة ريماس · المشغل الأول')).toBeVisible();
  expect(api.calls.find((c) => c.path === '/v1/platform/venues')).toBeTruthy();
  await expectMobileLayout(page);
  await page.getByText('قاعة ريماس · المشغل الأول').click();
  await expect(page.getByRole('button', { name: 'اعتماد' })).toBeVisible();
  // pricing is platform.plan_manage: an admin does not see it
  await expect(page.getByRole('button', { name: 'حفظ الأسعار' })).toHaveCount(0);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'إرجاع للتعديل' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('الصورة غير واضحة');
  await dialog.getByRole('button', { name: 'إرجاع للتعديل' }).click();
  await expect(page.getByRole('button', { name: 'اعتماد' })).toHaveCount(0);
  const call = api.callsTo('POST', `/v1/platform/venues/${VENUE_ID}/send-back`)[0]!;
  expect(call.body).toEqual({ expected_version: 3, reason: 'الصورة غير واضحة' });
  expect(call.headers['idempotency-key']).toBeTruthy();
});

test('P-04: the owner also sets the prices', async ({ page }) => {
  await platformApi(page, platformMe('platform_owner', ['platform.venue_review', 'platform.plan_manage']));
  await page.goto(`/platform/venues/${VENUE_ID}`);
  await expect(page.getByRole('button', { name: 'حفظ الأسعار' })).toBeVisible();
  await expect(page.locator('#p04-price')).toHaveValue('20');
  await expectMobileLayout(page);
});
