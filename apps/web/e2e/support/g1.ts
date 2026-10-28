import { expect, type Page } from '@playwright/test';
import type { CommandLog } from './commandLog';
import { PHOTO, pressCommand, REQUIRED_ANGLES, startDutyFromUi } from './driver';
import { SEED_IDS } from './fake/seed';

/**
 * The G1 path of 16 / TC-057 through the UI, on the paper channel: DRV1 starts the shift, takes a car in
 * (D-04 → D-05 → D-06 → D-07) and parks it (D-08) in A-03 / slot 12 of «لوحة 1»; the retrieval is
 * requested on behalf of the customer (`requestOnBehalf`); DRV2 — the longest-idle driver — gets the single
 * offer on D-04, accepts, picks the key up, starts, marks ready (D-10) and hands over against the stub
 * (D-11). Every press goes through `pressCommand` on the actor's log. Shared by the fake-backend spec and the
 * real-API run (PNT-036), which assert the backend each in its own way.
 */
export interface G1Actor {
  page: Page;
  log: CommandLog;
}

export const G1 = {
  event: 'حفل تجريبي — ريماس 1',
  plate: ['ب B', 'ح J', 'د D'],
  digits: '1234',
  serial: '004521',
  keyTag: '57',
  spot: 'A-03',
  slot: '12',
} as const;

export async function runG1Path(
  drv1: G1Actor,
  drv2: G1Actor,
  requestOnBehalf: (ticketId: string) => Promise<void>,
): Promise<{ ticketId: string; displayNumber: number }> {
  // D-03 — both drivers start their duty (DRV1 first, so DRV2 is the longest idle once DRV1 has parked)
  await startDutyFromUi(drv1.log, drv1.page);
  await startDutyFromUi(drv2.log, drv2.page);

  // D-04 → event chooser (RMS has two open events, DEC-37) → POST /v1/tickets
  const p1 = drv1.page;
  await p1.locator('#intake-start').click();
  const chooser = p1.getByRole('dialog', { name: 'لأي حفل هذه المركبة؟' });
  await pressCommand(drv1.log, 'POST /v1/tickets', chooser.getByRole('button', { name: G1.event }), {
    pending: p1.locator('#intake-start'),
  });

  // D-05 — plate, make, model, colour, paper stub
  await expect(p1).toHaveURL(/\/d\/intake\/[^/]+\/vehicle$/);
  const ticketId = /\/d\/intake\/([^/]+)\/vehicle$/.exec(p1.url())?.[1] ?? '';
  const n = 1;
  await expect(p1.getByRole('heading', { level: 1 })).toHaveText(`استلام مركبة · #${n}`);
  await expect(p1.getByText(`الحفل: ${G1.event}`)).toBeVisible();
  for (const letter of G1.plate) await p1.getByRole('button', { name: letter, exact: true }).click();
  await p1.locator('#plate-digits').fill(G1.digits);
  await p1.getByLabel('الشركة المصنعة').selectOption('toyota');
  await p1.getByLabel('الطراز (اختياري)').fill('كامري');
  await p1.getByRole('radio', { name: 'أبيض' }).click();
  await p1.getByLabel('رقم التذكرة الورقية').fill(G1.serial);
  await pressCommand(drv1.log, 'PATCH /v1/tickets/:ticketId/intake', p1.locator('#intake-next'));

  // D-06 — key tag, the four required photos (compressed, presigned PUT, complete), submit
  await expect(p1).toHaveURL(/\/key-photos$/);
  await p1.getByLabel('رقم علاقة المفتاح').fill(G1.keyTag);
  for (const angle of REQUIRED_ANGLES) await p1.getByLabel(`تصوير ${angle}`).setInputFiles(PHOTO);
  await expect(p1.getByRole('heading', { name: 'صور الحالة (4 من 4)' })).toBeVisible({ timeout: 20_000 });
  await pressCommand(drv1.log, 'POST /v1/tickets/:ticketId/submit-intake', p1.locator('#intake-submit'));

  // D-07 — paper stub
  await expect(p1.getByRole('heading', { level: 1 })).toHaveText(`تذكرة ورقية · #${n}`);
  await expect(
    p1.getByText(`سلّم العميل الكعب رقم ${G1.serial}، وعلّق الجزء الآخر على المفتاح.`),
  ).toBeVisible();
  await p1.getByLabel('سلّمت الكعب للعميل').check();
  await p1.getByRole('button', { name: 'متابعة إلى الصف' }).click();

  // D-08 — spot A-03, key slot 12 on «لوحة 1»
  await expect(p1.getByRole('heading', { level: 1 })).toHaveText(`إتمام الصف · #${n}`);
  await p1.getByRole('radio', { name: G1.spot, exact: true }).click();
  await expect(p1.locator('#key-board')).toHaveValue(SEED_IDS.keyBoards.RMS);
  await p1.getByRole('radio', { name: G1.slot, exact: true }).click();
  await p1.getByLabel('أودعت المفتاح في الخانة المختارة').check();
  await pressCommand(drv1.log, 'POST /v1/tasks/:taskId/complete-parking', p1.locator('#park-submit'));
  await expect(p1.getByText(`تم صف #${n}`)).toBeVisible();
  await expect(p1).toHaveURL(/\/d$/);

  // the customer presents the stub: a request on behalf → single offer to the longest-idle driver
  await requestOnBehalf(ticketId);

  // D-09 — DRV2 sees the single offer on D-04 (polling) and accepts it
  const p2 = drv2.page;
  const offer = p2.getByRole('region', { name: `طلب إحضار جديد، تذكرة ${n}` });
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await expect(offer).toContainText('طلب إحضار — لك');
  await pressCommand(
    drv2.log,
    'POST /v1/task-offers/:offerId/accept',
    offer.getByRole('button', { name: 'قبول الطلب' }),
  );
  await expect(p2.getByText(`قبلت الطلب #${n}`)).toBeVisible();

  // D-10 — key pickup → start → ready → handover
  await expect(p2.getByRole('heading', { level: 1 })).toHaveText(`إحضار · #${n}`);
  await expect(p2.getByText(`خانة المفتاح: لوحة 1 · ${G1.slot}`).first()).toBeVisible();
  await pressCommand(
    drv2.log,
    'POST /v1/tasks/:taskId/key-pickup',
    p2.getByRole('button', { name: 'استلمت المفتاح' }),
  );
  await expect(p2.getByText(`الموقف: ${G1.spot} (المنطقة A)`).first()).toBeVisible();
  await pressCommand(
    drv2.log,
    'POST /v1/tasks/:taskId/start-retrieval',
    p2.getByRole('button', { name: 'بدء الإحضار' }),
  );
  await pressCommand(
    drv2.log,
    'POST /v1/tasks/:taskId/ready',
    p2.getByRole('button', { name: 'وصلت — جاهزة' }),
  );
  await p2.getByRole('button', { name: 'التسليم' }).click();

  // D-11 — paper stub, then «تم تسليم #1» and back to D-04
  await expect(p2.getByRole('heading', { level: 1 })).toHaveText(`التسليم · #${n}`);
  await p2.getByLabel('رقم الكعب').fill(G1.serial);
  await pressCommand(drv2.log, 'POST /v1/tickets/:ticketId/handover', p2.locator('#handover-submit'));
  await expect(p2.getByText(`تم تسليم #${n}`)).toBeVisible();
  await expect(p2).toHaveURL(/\/d$/, { timeout: 10_000 });
  return { ticketId, displayNumber: n };
}
