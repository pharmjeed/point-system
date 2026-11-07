import { expect, test } from '@playwright/test';
import { MockApi, mockStaffApi, roleMe } from './support/api';
import { expectMobileLayout } from './support/checks';

/** V2-005 (DEC-486): the suspended / terminated operator banner over the staff shell at 360, 390 and 430 px. */
test('the suspended operator banner over the staff shell', async ({ page }) => {
  const org = { id: 'org', name_ar: 'مؤسسة', operator_status: 'suspended' };
  const api = new MockApi(page, { ...roleMe('supervisor'), organization: org });
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops');
  await expect(page.getByText(/حساب المشغّل معلّق من المنصة/)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
  // terminated: the other text
  api.me = { ...roleMe('supervisor'), organization: { ...org, operator_status: 'terminated' } };
  await page.reload();
  await expect(page.getByText(/أُنهي حساب المشغّل في المنصة/)).toBeVisible();
  // active: no banner
  api.me = { ...roleMe('supervisor'), organization: { ...org, operator_status: 'active' } };
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/حساب المشغّل/)).toHaveCount(0);
});
