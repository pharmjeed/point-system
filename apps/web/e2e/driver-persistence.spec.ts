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

/** The keys of one store of the local intake database (`point-field`). */
function localRows(page: Page, store: 'drafts' | 'photos'): Promise<string[]> {
  return page.evaluate(async (s) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('point-field', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('drafts', { keyPath: 'id' });
        req.result.createObjectStore('photos', { keyPath: 'id' }).createIndex('draft', 'draftId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const keys = await new Promise<string[]>((resolve) => {
      const r = db.transaction(s, 'readonly').objectStore(s).getAllKeys();
      r.onsuccess = () => resolve((r.result as IDBValidKey[]).map(String));
      r.onerror = () => resolve([]);
    });
    db.close();
    return keys.sort();
  }, store);
}

/** Writes rows into the local intake database, as an earlier app session would have left them. */
function putRows(
  page: Page,
  rows: { drafts?: Array<Record<string, unknown>>; photos?: Array<Record<string, unknown>> },
): Promise<void> {
  return page.evaluate(async ({ drafts, photos }) => {
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
      const tx = db.transaction(['drafts', 'photos'], 'readwrite');
      for (const d of drafts ?? []) tx.objectStore('drafts').put(d);
      for (const p of photos ?? [])
        tx.objectStore('photos').put({
          ...p,
          blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
        });
      tx.oncomplete = () => resolve();
    });
    db.close();
  }, rows);
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

test('PNT-071: «المتابعة دون انتظار», then a reload — the photo still uploading completes from the frame', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fake = createFake();
  const ticketId = newIntake(fake);
  const userId = fake.userByKey('DRV1').id;
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicleStep(page);
  await page.locator('#intake-next').click();
  await expect(page).toHaveURL(/\/key-photos$/);
  await page.getByLabel('رقم علاقة المفتاح').fill('57');
  for (const angle of ['الأمام', 'الخلف', 'الجانب الأيسر'])
    await page.getByLabel(`تصوير ${angle}`).setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'صور الحالة (3 من 4)' })).toBeVisible({ timeout: 20_000 });

  // the fourth photo's bytes are still travelling when the driver goes on (02 D-06)
  fake.delayNext('PUT /__e2e_storage/:mediaId', 20_000);
  await page.getByLabel('تصوير الجانب الأيمن').setInputFiles(PHOTO);
  await page.getByRole('button', { name: 'المتابعة دون انتظار' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'متابعة وإبلاغ المشرف' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^تذكرة ورقية · #\d+$/);
  expect(fake.world.tickets.find((t) => t.id === ticketId)?.status).toBe('parking');
  // the inputs and the draft row are gone; the pending photo stays with its bytes
  await expect.poll(() => localRows(page, 'drafts')).toEqual([]);
  expect(await localRows(page, 'photos')).toEqual([`${userId}:${ticketId}:photo_right`]);

  // the app is closed and opened again before the bytes arrived: the frame resumes the photo (same media
  // request, the same media row) and the late photo completes the inspection
  await page.reload();
  await expect
    .poll(
      () => fake.world.media.find((m) => m.ticket_id === ticketId && m.kind === 'photo_right')?.upload_status,
      { timeout: 30_000 },
    )
    .toBe('uploaded');
  expect(fake.world.media.filter((m) => m.ticket_id === ticketId && m.kind === 'photo_right')).toHaveLength(
    1,
  );
  expect(fake.world.tickets.find((t) => t.id === ticketId)?.inspection_status).toBe('complete');
  await expect.poll(() => localRows(page, 'photos')).toEqual([]);
});

test('PNT-071: rows of tickets the driver never reopens go at the next app start; the current intake stays', async ({
  browser,
}) => {
  const fake = createFake();
  const current = newIntake(fake);
  const gone = crypto.randomUUID(); // voided by a supervisor / finished on another device: not his any more
  const userId = fake.userByKey('DRV1').id;
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d/account');
  await expect(page.getByRole('heading', { name: 'حسابي' })).toBeVisible();
  await putRows(page, {
    drafts: [
      { id: `${userId}:${current}`, userId, ticketId: current, paperSerial: SERIAL },
      { id: `${userId}:${gone}`, userId, ticketId: gone, paperSerial: '888888' },
    ],
    photos: [
      {
        id: `${userId}:${gone}:photo_front`,
        draftId: `${userId}:${gone}`,
        userId,
        ticketId: gone,
        slot: 'photo_front',
        kind: 'photo_front',
        capturedAt: new Date().toISOString(),
        state: 'failed',
        retriable: true,
        intent: null,
        savedAt: 0,
      },
    ],
  });
  await page.reload();
  await expect.poll(() => localRows(page, 'drafts')).toEqual([`${userId}:${current}`]);
  await expect.poll(() => localRows(page, 'photos')).toEqual([]);
  const dump = await browserStorageDump(page);
  expect(dump).not.toContain('888888');
});

test('PNT-071: a session revoked for a transfer takes the drafts of the previous venue with it (02 §1.11)', async ({
  browser,
}) => {
  const fake = createFake();
  const ticketId = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicleStep(page);
  await expect.poll(async () => (await browserStorageDump(page)).includes(SERIAL)).toBe(true);
  fake.failNext(
    'PATCH /v1/tickets/:ticketId/intake',
    errorReply('AUTH_SESSION_REVOKED', { reason: 'transfer', venue_name_ar: 'قاعة ليالي' }),
  );
  await page.locator('#intake-next').click();
  await expect(page).toHaveURL(/\/session-ended$/);
  await expect(
    page.getByText('تم نقلك إلى قاعة ليالي. سجّل الدخول لمتابعة العمل في موقعك الجديد.'),
  ).toBeVisible();
  await expect.poll(async () => (await browserStorageDump(page)).includes(SERIAL)).toBe(false);
  expect(await localRows(page, 'drafts')).toEqual([]);
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
  // the frame settles the local rows at the first snapshot of the session; this test's rows come after it
  await expect.poll(() => fake.callsTo('GET /v1/me/home').length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  // a draft written after that by DRV1 and one of another user
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
