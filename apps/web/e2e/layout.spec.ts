import { expect, test } from '@playwright/test';
import { driverMe, MockApi, staffMe } from './support/api';
import { expectMobileLayout } from './support/checks';
import {
  acceptOfferOf,
  arrangeParked,
  arrangeRetrieval,
  arrangeSubmitted,
  EVENT_R1,
  EVENT_R2,
  requestRetrieval,
  startDuty,
  uploadPhoto,
} from './support/driver';
import { createFake, SEED_IDS, type FakeServer, type SeedUserKey } from './support/fake';

/**
 * PNT-021 acceptance 1 & 2 (17 TC-059, TC-060): every shell page and every sign-in screen at 360, 390 and
 * 430 px (one project each), in light and dark: no horizontal scroll, RTL, 16px base font, ≥44px targets.
 * PNT-023 adds the setup screens (S-05, S-06, S-08, S-09) with data from the fake backend; PNT-035 the
 * driver's field screens D-04 … D-11, each on a world arranged through the fake (DRV1 at RMS).
 */
const RMS = SEED_IDS.venues.RMS;

/** A new intake by DRV1: D-05 (`step1: false`) or D-06 with step 1 saved and two photos uploaded. */
function intakeDraft(fake: FakeServer, step1: boolean): string {
  startDuty(fake, 'DRV1');
  const created = fake.exec('DRV1', 'POST /v1/tickets', {}, { event_id: EVENT_R1 });
  const ticketId: string = created.ticket.id;
  if (!step1) return `/d/intake/${ticketId}/vehicle`;
  fake.exec(
    'DRV1',
    'PATCH /v1/tickets/:ticketId/intake',
    { ticketId },
    {
      expected_version: created.ticket.version,
      channel: 'paper',
      plate: { country: 'SA', digits: '1234', letters_ar: 'ب ح د', letters_en: 'B J D' },
      vehicle: { make: 'toyota', model: 'كامري', color: 'white' },
      paper_serial: '004521',
    },
  );
  uploadPhoto(fake, 'DRV1', ticketId, 'photo_front');
  uploadPhoto(fake, 'DRV1', ticketId, 'photo_rear');
  return `/d/intake/${ticketId}/key-photos`;
}

const PAGES: Array<{
  /** Fixed path, or `prepare` arranges the fake's world and returns it. */
  path?: string;
  prepare?: (fake: FakeServer) => string;
  /** Test title when the path is computed. */
  name?: string;
  me: Record<string, unknown> | null;
  area: 'driver' | 'staff';
  heading?: RegExp;
  /** A text proving the arranged state is on screen (not only the frame). */
  shows?: string | RegExp;
  /** Served by the fake backend as this seeded user instead of the static mock. */
  as?: SeedUserKey;
}> = [
  { path: '/login', me: null, area: 'driver', heading: /تسجيل الدخول/ },
  { path: '/staff/login', me: null, area: 'staff', heading: /دخول المشرفين والإدارة/ },
  { path: '/session-ended', me: null, area: 'driver', heading: /انتهت جلستك/ },
  {
    path: '/account/secret',
    me: driverMe({ mustChange: true }),
    area: 'driver',
    heading: /تغيير الرقم السري/,
  },
  { path: '/d/start', me: driverMe(), area: 'driver', heading: /بدء الوردية/ },
  { path: '/d', me: driverMe({ onDuty: true, state: 'busy_with_next' }), area: 'driver' },
  {
    path: '/d/vehicles',
    me: driverMe({ onDuty: true, state: 'retrieving' }),
    area: 'driver',
    heading: /المركبات/,
  },
  { path: '/d/account', me: driverMe({ onDuty: true }), area: 'driver', heading: /حسابي/ },
  { path: '/ops', me: staffMe(), area: 'staff', heading: /التشغيل/ },
  { path: '/drivers', me: null, as: 'ADM1', area: 'staff', heading: /السائقون/ },
  { path: `/drivers/${SEED_IDS.users.DRV1}`, me: null, as: 'ADM1', area: 'staff', heading: /سائق 1/ },
  { path: '/venues', me: null, as: 'ADM1', area: 'staff', heading: /المواقع والحفلات/ },
  { path: `/venues/${RMS}`, me: null, as: 'SUP-R', area: 'staff', heading: /قاعة ريماس/ },
  { path: `/venues/${RMS}?tab=shifts`, me: null, as: 'SUP-R', area: 'staff', heading: /قاعة ريماس/ },
  { path: `/venues/${RMS}/setup`, me: null, as: 'ADM1', area: 'staff', heading: /إعداد الموقع/ },
  ...(['parking', 'keys', 'pools', 'timers', 'handover', 'inspection'] as const).map((section) => ({
    path: `/venues/${RMS}/setup?section=${section}`,
    me: null,
    as: 'ADM1' as const,
    area: 'staff' as const,
  })),
  { path: '/reports', me: staffMe(), area: 'staff', heading: /التقارير/ },
  { path: '/admin', me: staffMe(), area: 'staff', heading: /الإدارة/ },
  // PNT-035 — the field screens of the first vertical path
  {
    name: 'D-03 (fake)',
    prepare: () => '/d/start',
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /بدء الوردية/,
    shows: /الوردية: مفتوحة منذ/,
  },
  {
    name: 'D-04 single offer',
    prepare: (fake) => {
      startDuty(fake, 'DRV1');
      requestRetrieval(fake, arrangeParked(fake, 'DRV1').ticketId);
      return '/d';
    },
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /الرئيسية/,
    shows: 'طلب إحضار — لك',
  },
  {
    name: 'D-04 current and next task',
    prepare: (fake) => {
      startDuty(fake, 'DRV1');
      const a = arrangeParked(fake, 'DRV1', { serial: '004601', keyTag: '71', spot: 'A-10', slot: '20' });
      const b = arrangeParked(fake, 'DRV1', { serial: '004602', keyTag: '72', spot: 'A-11', slot: '21' });
      requestRetrieval(fake, a.ticketId);
      acceptOfferOf(fake, 'DRV1', a.ticketId);
      requestRetrieval(fake, b.ticketId); // nobody free → broadcast; DRV1 reserves it as next
      acceptOfferOf(fake, 'DRV1', b.ticketId);
      return '/d';
    },
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /الرئيسية/,
    shows: 'تبدأ بعد إنهاء مهمتك الحالية. لا تبدأ الحركة قبل ذلك.',
  },
  {
    name: 'D-05',
    prepare: (fake) => intakeDraft(fake, false),
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /استلام مركبة/,
    shows: 'الحفل: حفل تجريبي — ريماس 1',
  },
  {
    name: 'D-06',
    prepare: (fake) => intakeDraft(fake, true),
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /استلام مركبة/,
    shows: 'صور الحالة (2 من 4)',
  },
  {
    name: 'D-07 paper',
    prepare: (fake) => {
      startDuty(fake, 'DRV1');
      return `/d/intake/${arrangeSubmitted(fake, 'DRV1').ticketId}/link`;
    },
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /تذكرة ورقية/,
    shows: 'سلّمت الكعب للعميل',
  },
  {
    name: 'D-08',
    prepare: (fake) => {
      startDuty(fake, 'DRV1');
      return `/d/tasks/${arrangeSubmitted(fake, 'DRV1').parkTaskId}/park`;
    },
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /إتمام الصف/,
    shows: 'لوحة المفاتيح',
  },
  {
    name: 'D-10',
    prepare: (fake) => {
      startDuty(fake, 'DRV1');
      return `/d/tasks/${arrangeRetrieval(fake, 'DRV1', 'key').taskId}`;
    },
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /إحضار/,
    shows: 'عند البدء يصل العميل إشعار «جارٍ إحضار سيارتك».',
  },
  {
    name: 'D-11 with collection',
    prepare: (fake) => {
      startDuty(fake, 'DRV1');
      return `/d/tickets/${arrangeRetrieval(fake, 'DRV1', 'ready', { eventId: EVENT_R2 }).ticketId}/handover`;
    },
    me: null,
    as: 'DRV1',
    area: 'driver',
    heading: /التسليم/,
    shows: /المبلغ المستحق: 20\.00/,
  },
];

for (const theme of ['light', 'dark'] as const) {
  for (const p of PAGES) {
    test(`${p.name ?? p.path} — ${theme}`, async ({ page }) => {
      if (theme === 'dark') {
        // Driver screens follow the device (DEC-19); staff screens are light unless switched in ☰.
        await page.emulateMedia({ colorScheme: 'dark' });
        if (p.area === 'staff')
          await page.addInitScript(() => localStorage.setItem('point.theme.staff', 'dark'));
      }
      let path = p.path ?? '/';
      if (p.as) {
        const fake = createFake();
        if (p.prepare) path = p.prepare(fake);
        await fake.attach(page, p.as);
      } else await new MockApi(page, p.me).install();
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      if (p.heading) await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.heading);
      if (p.shows) await expect(page.getByText(p.shows).first()).toBeVisible();
      if (p.as) await expect(page.locator('.pt-skel-card')).toHaveCount(0); // data loaded, not skeletons
      await page.evaluate(() => document.fonts.ready);
      await expectMobileLayout(page);
      const dark = await page.evaluate(() => {
        const bg = getComputedStyle(document.body).backgroundColor;
        const [r = 0, g = 0, b = 0] = (bg.match(/\d+/g) ?? []).map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60;
      });
      expect(dark, `${theme} background`).toBe(theme === 'dark');
    });
  }
}

test('the staff shell switches to the side navigation from 1024 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await new MockApi(page, staffMe()).install();
  await page.goto('/ops');
  await expect(page.getByRole('navigation', { name: 'أقسام لوحة المشرف' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
