import { expect, test } from '@playwright/test';
import { actorPage, expectCommandContract } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import {
  EVENT_R1,
  offerOf,
  PHOTO,
  pressCommand,
  REQUIRED_ANGLES,
  requestRetrieval,
  startDutyFromUi,
} from './support/driver';
import { createFake, SEED_IDS } from './support/fake';

/**
 * PNT-035 acceptance 1–2 (the G1 path of 16 / TC-057, on the paper channel): DRV1 starts the shift, takes a
 * car in (D-04 → D-05 → D-06 → D-07) and parks it (D-08); a retrieval is requested on behalf of the
 * customer; DRV2 — the longest-idle driver — gets the single offer (D-09), picks the key up, retrieves, marks
 * it ready (D-10) and hands it over against the paper stub (D-11). Every command press is checked: one
 * request with a UUIDv4 Idempotency-Key, the button disabled and busy until the (delayed) reply. Then the
 * actors and the custody chain of the ticket and its cycle are asserted on the fake backend's world
 * (the same path against the real API, with these checks as API reads, is PNT-036: support/backend.ts).
 */
runOnlyAt390();
fakeOnly();

test('G1 at 390 px: DRV1 takes in and parks on paper; DRV2 accepts, retrieves and hands over', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fake = createFake();
  const drv1 = await actorPage(browser, fake, 'DRV1');
  const drv2 = await actorPage(browser, fake, 'DRV2');
  const DRV1 = SEED_IDS.users.DRV1;
  const DRV2 = SEED_IDS.users.DRV2;

  // D-03 — both drivers start their duty (DRV1 first)
  await startDutyFromUi(fake, drv1.page);
  await startDutyFromUi(fake, drv2.page);

  // D-04 → event chooser (RMS has two open events, DEC-37) → POST /v1/tickets
  const p1 = drv1.page;
  await p1.locator('#intake-start').click();
  const chooser = p1.getByRole('dialog', { name: 'لأي حفل هذه المركبة؟' });
  await pressCommand(
    fake,
    'POST /v1/tickets',
    chooser.getByRole('button', { name: /حفل تجريبي — ريماس 1/ }),
    {
      pending: p1.locator('#intake-start'),
    },
  );

  // D-05 — plate, make, model, colour, paper stub
  await expect(p1.getByRole('heading', { level: 1 })).toHaveText('استلام مركبة · #1');
  await expect(p1.getByText('الحفل: حفل تجريبي — ريماس 1')).toBeVisible();
  for (const letter of ['ب B', 'ح J', 'د D'])
    await p1.getByRole('button', { name: letter, exact: true }).click();
  await p1.locator('#plate-digits').fill('1234');
  await p1.getByLabel('الشركة المصنعة').selectOption('toyota');
  await p1.getByLabel('الطراز (اختياري)').fill('كامري');
  await p1.getByRole('radio', { name: 'أبيض' }).click();
  await p1.getByLabel('رقم التذكرة الورقية').fill('004521');
  await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', p1.locator('#intake-next'));

  // D-06 — key tag, the four required photos (compressed, presigned PUT, complete), submit
  await expect(p1).toHaveURL(/\/key-photos$/);
  await p1.getByLabel('رقم علاقة المفتاح').fill('57');
  for (const angle of REQUIRED_ANGLES) await p1.getByLabel(`تصوير ${angle}`).setInputFiles(PHOTO);
  await expect(p1.getByRole('heading', { name: 'صور الحالة (4 من 4)' })).toBeVisible({ timeout: 15_000 });
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', p1.locator('#intake-submit'));

  // D-07 — paper stub
  await expect(p1.getByRole('heading', { level: 1 })).toHaveText('تذكرة ورقية · #1');
  await expect(p1.getByText('سلّم العميل الكعب رقم 004521، وعلّق الجزء الآخر على المفتاح.')).toBeVisible();
  await p1.getByLabel('سلّمت الكعب للعميل').check();
  await p1.getByRole('button', { name: 'متابعة إلى الصف' }).click();

  // D-08 — spot A-03, key slot 12 on «لوحة 1»
  await expect(p1.getByRole('heading', { level: 1 })).toHaveText('إتمام الصف · #1');
  await p1.getByRole('radio', { name: 'A-03', exact: true }).click();
  await expect(p1.getByLabel('لوحة المفاتيح')).toHaveValue(SEED_IDS.keyBoards.RMS);
  await p1.getByRole('radio', { name: '12', exact: true }).click();
  await p1.getByLabel('أودعت المفتاح في الخانة المختارة').check();
  await pressCommand(fake, 'POST /v1/tasks/:taskId/complete-parking', p1.locator('#park-submit'));
  await expect(p1.getByText('تم صف #1')).toBeVisible();
  await expect(p1).toHaveURL(/\/d$/);

  const ticket = fake.world.tickets.find((t) => t.event_id === EVENT_R1 && t.display_number === 1);
  expect(ticket).toMatchObject({ status: 'parked', created_by: DRV1, parked_by: DRV1, key_tag: '57' });
  expect(
    fake.world.media.filter((m) => m.ticket_id === ticket?.id && m.upload_status === 'uploaded'),
  ).toHaveLength(4);

  // the customer presents the stub: a request on behalf (SUP-R) → single offer to the longest-idle driver
  requestRetrieval(fake, ticket?.id ?? '');
  expect(offerOf(fake, ticket?.id ?? '')).toMatchObject({ mode: 'single', recipients: [DRV2] });

  // D-09 — DRV2 sees the single offer on D-04 (polling) and accepts it
  const p2 = drv2.page;
  const offer = p2.getByRole('region', { name: 'طلب إحضار جديد، تذكرة 1' });
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await expect(offer).toContainText('طلب إحضار — لك');
  await pressCommand(
    fake,
    'POST /v1/task-offers/:offerId/accept',
    offer.getByRole('button', { name: 'قبول الطلب' }),
  );
  await expect(p2.getByText('قبلت الطلب #1')).toBeVisible();

  // D-10 — key pickup → start → ready → handover
  await expect(p2.getByRole('heading', { level: 1 })).toHaveText('إحضار · #1');
  await expect(p2.getByText('خانة المفتاح: لوحة 1 · 12').first()).toBeVisible();
  await pressCommand(
    fake,
    'POST /v1/tasks/:taskId/key-pickup',
    p2.getByRole('button', { name: 'استلمت المفتاح' }),
  );
  await expect(p2.getByText('الموقف: A-03 (المنطقة A)').first()).toBeVisible();
  await pressCommand(
    fake,
    'POST /v1/tasks/:taskId/start-retrieval',
    p2.getByRole('button', { name: 'بدء الإحضار' }),
  );
  await pressCommand(fake, 'POST /v1/tasks/:taskId/ready', p2.getByRole('button', { name: 'وصلت — جاهزة' }));
  await p2.getByRole('button', { name: 'التسليم' }).click();

  // D-11 — paper stub, then «تم تسليم #1» and back to D-04
  await expect(p2.getByRole('heading', { level: 1 })).toHaveText('التسليم · #1');
  await p2.getByLabel('رقم الكعب').fill('004521');
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/handover', p2.locator('#handover-submit'));
  await expect(p2.getByText('تم تسليم #1')).toBeVisible();
  await expect(p2).toHaveURL(/\/d$/, { timeout: 10_000 });

  // TC-057: the right actor on every record, the full custody chain, one audit row per command
  expect(ticket).toMatchObject({
    status: 'delivered',
    created_by: DRV1,
    parked_by: DRV1,
    retrieved_by: DRV2,
    delivered_by: DRV2,
  });
  const cycle = fake.world.cycles.find((c) => c.ticket_id === ticket?.id);
  expect(cycle).toMatchObject({
    accepted_by: DRV2,
    retrieved_by: DRV2,
    delivered_by: DRV2,
    outcome: 'delivered',
  });
  const who = (id: string) => fake.world.users.find((u) => u.id === id)?.key;
  const chain = fake.world.custody
    .filter((e) => e.ticket_id === ticket?.id)
    .map((e) => `${e.subject}: ${e.from.type} → ${e.to.type} (${e.reason}) by ${who(e.actor_id)}`);
  expect(chain).toEqual([
    'vehicle: customer → driver (intake) by DRV1',
    'key: customer → driver (intake) by DRV1',
    'vehicle: driver → spot (parked) by DRV1',
    'key: driver → key_slot (key_deposited) by DRV1',
    'key: key_slot → driver (key_pickup) by DRV2',
    'vehicle: spot → driver (retrieval_start) by DRV2',
    'vehicle: driver → customer (handover) by DRV2',
    'key: driver → customer (handover) by DRV2',
  ]);
  const audit = fake.world.audit.map((a) => `${a.route} by ${who(a.actor_id)}`);
  for (const route of [
    'POST /v1/tickets',
    'PATCH /v1/tickets/:ticketId/intake',
    'POST /v1/tickets/:ticketId/submit-intake',
    'POST /v1/tasks/:taskId/complete-parking',
  ])
    expect(audit).toContain(`${route} by DRV1`);
  for (const route of [
    'POST /v1/task-offers/:offerId/accept',
    'POST /v1/tasks/:taskId/key-pickup',
    'POST /v1/tasks/:taskId/start-retrieval',
    'POST /v1/tasks/:taskId/ready',
    'POST /v1/tickets/:ticketId/handover',
  ])
    expect(audit).toContain(`${route} by DRV2`);
  expect(fake.world.duties.find((d) => d.user_id === DRV2 && d.status === 'on_duty')).toBeTruthy();
  expectCommandContract(fake, ['POST /v1/tickets/:ticketId/media', 'POST /v1/media/:mediaId/complete']);
});
