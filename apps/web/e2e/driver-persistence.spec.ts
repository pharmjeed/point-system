import { expect, test, type Page } from '@playwright/test';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { browserStorageDump, runOnlyAt390 } from './support/checks';
import { EVENT_R1, PHOTO, startDuty } from './support/driver';
import { createFake, errorReply, type FakeServer } from './support/fake';

/**
 * PNT-071 — the intake survives a weak network and a reload (02 §1.8, D-05, D-06; 03 §4.3; AC-21 / TC-061):
 * the D-05/D-06 inputs and the pending photos are kept in IndexedDB per user and ticket, a pending photo
 * resumes by itself, an unanswered command is sent again with the SAME Idempotency-Key after the reload,
 * and the server sees one effect. The drafts go with the intake, at sign-out, and stay through a session
 * that ended by itself (02 §1.9).
 */
runOnlyAt390();
fakeOnly();

const SERIAL = '004521';

async function fillVehicleStep(page: Page): Promise<void> {
  for (const letter of ['ب B', 'ح J', 'د D'])
    await page.getByRole('button', { name: letter, exact: true }).click();
  await page.locator('#plate-digits').fill('1234');
  await page.getByLabel('الشركة المصنعة').selectOption('toyota');
  await page.getByLabel('الطراز (اختياري)').fill('كامري');
  await page.getByRole('radio', { name: 'أبيض' }).click();
  await page.getByLabel('رقم التذكرة الورقية').fill(SERIAL);
}

function newIntake(fake: FakeServer): string {
  startDuty(fake, 'DRV1');
  return fake.exec('DRV1', 'POST /v1/tickets', {}, { event_id: EVENT_R1 }).ticket.id as string;
}

test('PNT-071 / AC-21 TC-061: a cut at the submit, a reload, the same Idempotency-Key and one effect', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fake = createFake();
  const ticketId = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);

  // D-05: what was typed is back after a reload (saved 300 ms after the last change)
  await fillVehicleStep(page);
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('#plate-digits')).toHaveValue('1234');
  await expect(page.getByLabel('الطراز (اختياري)')).toHaveValue('كامري');
  await expect(page.getByLabel('رقم التذكرة الورقية')).toHaveValue(SERIAL);
  await expect(page.getByLabel('الشركة المصنعة')).toHaveValue('toyota');
  await page.locator('#intake-next').click();

  // D-06: key tag, notes, three photos on the server, the fourth one's upload is cut
  await expect(page).toHaveURL(/\/key-photos$/);
  await page.getByLabel('رقم علاقة المفتاح').fill('57');
  await page.getByLabel('ملاحظات الأضرار (اختياري)').fill('خدش في الباب الخلفي');
  for (const angle of ['الأمام', 'الخلف', 'الجانب الأيسر'])
    await page.getByLabel(`تصوير ${angle}`).setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'صور الحالة (3 من 4)' })).toBeVisible({ timeout: 20_000 });
  fake.failNext('PUT /__e2e_storage/:mediaId', 'abort', 2); // the PUT and its automatic retry
  await page.getByLabel('تصوير الجانب الأيمن').setInputFiles(PHOTO);
  await expect(page.getByRole('alert').filter({ hasText: 'الجانب الأيمن' })).toBeVisible({ timeout: 20_000 });

  // «إتمام التسجيل» while the network is cut: the automatic retries (1, 3, 7 s) keep one key
  fake.failNext('POST /v1/tickets/:ticketId/submit-intake', 'abort', 4);
  await page.locator('#intake-submit').click();
  await expect
    .poll(() => fake.callsTo('POST /v1/tickets/:ticketId/submit-intake').length, { timeout: 30_000 })
    .toBe(4);
  const cut = fake.callsTo('POST /v1/tickets/:ticketId/submit-intake');
  const key = cut[0]?.headers['idempotency-key'];
  expect(cut.every((c) => c.headers['idempotency-key'] === key && c.status === -1)).toBe(true);
  await expect(page.locator('#intake-submit')).toBeEnabled({ timeout: 15_000 });
  expect(fake.world.tickets.find((t) => t.id === ticketId)?.status).toBe('received'); // nothing happened

  // reload: the inputs, the pending photo (resumed by itself) and the unanswered submit come back
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByLabel('رقم علاقة المفتاح')).toHaveValue('57');
  await expect(page.getByLabel('ملاحظات الأضرار (اختياري)')).toHaveValue('خدش في الباب الخلفي');
  await expect(page.getByRole('heading', { name: 'صور الحالة (4 من 4)' })).toBeVisible({ timeout: 20_000 });
  const rightPhotos = fake.world.media.filter((m) => m.ticket_id === ticketId && m.kind === 'photo_right');
  expect(rightPhotos).toHaveLength(1); // resumed with the same media request, not a second row

  // the network is back: the same intent goes again with the same key — one effect
  await page.locator('#intake-submit').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^تذكرة ورقية · #\d+$/);
  const all = fake.callsTo('POST /v1/tickets/:ticketId/submit-intake');
  expect(all).toHaveLength(5);
  expect(new Set(all.map((c) => c.headers['idempotency-key']))).toEqual(new Set([key]));
  expect(all.filter((c) => c.status >= 200 && c.status < 300)).toHaveLength(1);
  expect(fake.world.tickets.find((t) => t.id === ticketId)?.status).toBe('parking');
  // the intake is over: its local draft and photos are gone
  await expect.poll(async () => (await browserStorageDump(page)).includes(SERIAL)).toBe(false);
});

test('PNT-071: a session that ends by itself keeps the draft for the same user (02 §1.9)', async ({
  browser,
}) => {
  const fake = createFake();
  const ticketId = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicleStep(page);
  // the session ends on «التالي», right after the typing (before the 300 ms save)
  fake.failNext('PATCH /v1/tickets/:ticketId/intake', errorReply('AUTH_SESSION_EXPIRED'));
  await page.locator('#intake-next').click();
  await expect(page).toHaveURL(/\/session-ended$/);
  // signed in again as the same driver (the fake session is still valid): the draft is back
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await expect(page.getByLabel('رقم التذكرة الورقية')).toHaveValue(SERIAL);
  await expect(page.getByLabel('الطراز (اختياري)')).toHaveValue('كامري');
  await expect(page.locator('#plate-digits')).toHaveValue('1234');
});

test('PNT-071: sign-out takes the local drafts of the user with it', async ({ browser }) => {
  const fake = createFake();
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d/account');
  await expect(page.getByRole('heading', { name: 'حسابي' })).toBeVisible();
  // a draft left from an earlier session of DRV1 (its ticket is gone) and one of another user
  const userId = fake.userByKey('DRV1').id;
  await page.evaluate(
    async ({ mine, serial }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('point-field', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('drafts', { keyPath: 'id' });
          req.result.createObjectStore('photos', { keyPath: 'id' }).createIndex('draft', 'draftId');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put({ id: `${mine}:t-old`, userId: mine, paperSerial: serial });
        tx.objectStore('drafts').put({
          id: 'someone-else:t-1',
          userId: 'someone-else',
          paperSerial: '777777',
        });
        tx.oncomplete = () => resolve();
      });
      db.close();
    },
    { mine: userId, serial: SERIAL },
  );
  expect(await browserStorageDump(page)).toContain(SERIAL);
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  const dump = await browserStorageDump(page);
  expect(dump).not.toContain(SERIAL);
  expect(dump).toContain('777777'); // another user's draft is not this sign-out's to delete
});
