import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import QRCode from 'qrcode';
import { generatePassToken, passStep } from '../../../packages/shared/src/customer/pass';
import { actorPage, expectCommandContract } from './support/actors';
import { fakeOnly } from './support/backend';
import { expectMobileLayout } from './support/checks';
import { EVENT_R1, EVENT_R2, pressCommand, PHOTO, REQUIRED_ANGLES, startDuty } from './support/driver';
import { createFake, type FakeServer } from './support/fake';
import { fakeNowMs } from './support/fake/http';
import type { FPassAccount } from './support/fake/server';

/**
 * V2-013 / V2-014 — «مسح بطاقة العميل» in D-05 (O-01) and the entitlement badge (O-02): the camera is the browser's
 * own getUserMedia replaced by a canvas stream that draws a real QR (the `qrcode` encoder), so the real decoder
 * (`@zxing/browser`) reads it; the fake backend verifies the token with the shared pure verifier. The functional flows
 * run at 390 px; the D-05 card with the badge is checked at 360 / 390 / 430.
 */
fakeOnly();

const FIRST = 'سارة';
const PHONE = '+966551234123';

/** The side of the fake camera's square frame, in pixels. */
const FRAME = 640;

/** A QR symbol as the fake camera paints it: `size`×`size` modules of `cell` px, the first at (`off`, `off`). */
type QrFrame = { size: number; cell: number; off: number; data: number[] };

function qrFrame(text: string, maskPattern?: number): QrFrame {
  const { modules } = QRCode.create(text, {
    errorCorrectionLevel: 'L',
    ...(maskPattern === undefined ? {} : { maskPattern: maskPattern as QRCode.QRCodeMaskPattern }),
  });
  const cell = Math.floor(560 / modules.size);
  return {
    size: modules.size,
    cell,
    off: Math.floor((FRAME - cell * modules.size) / 2),
    data: Array.from(modules.data),
  };
}

// the scanner's decoder (`@zxing/browser` wraps this library: HybridBinarizer + QRCodeReader, no hints); a CommonJS
// package whose named exports Node's ESM loader cannot see
const zxing = createRequire(import.meta.url)('@zxing/library') as typeof import('@zxing/library');

/** Whether the scanner's decoder reads `text` from the exact frame the fake camera paints for `f`. */
function decoderReads(f: QrFrame, text: string): boolean {
  const lum = new Uint8ClampedArray(FRAME * FRAME).fill(255);
  for (let y = 0; y < f.size; y++)
    for (let x = 0; x < f.size; x++)
      if (f.data[y * f.size + x])
        for (let row = f.off + y * f.cell; row < f.off + (y + 1) * f.cell; row++)
          lum.fill(0, row * FRAME + f.off + x * f.cell, row * FRAME + f.off + (x + 1) * f.cell);
  const bitmap = new zxing.BinaryBitmap(
    new zxing.HybridBinarizer(new zxing.RGBLuminanceSource(lum, FRAME, FRAME)),
  );
  try {
    return new zxing.QRCodeReader().decode(bitmap).getText() === text;
  } catch {
    return false;
  }
}

/**
 * The symbol to show for `text`: the encoder's own choice, or else the first of the 8 masks (all valid encodings of
 * the same text) the decoder reads. Needed because the frame is pixel-perfect, axis-aligned and identical every time:
 * for 4–6 % of symbols, a finder-like 1:1:3:1:1 run in the data area is taken by zxing's finder-pattern search for a
 * corner and the symbol is never located — in every frame alike, so a random secret made the scan specs flaky (the
 * encoder's mask choice only penalises such runs). A held phone never shows the same frame twice (a tilt of 2° alone
 * reads almost all of those symbols), so this is the harness's limit, not the driver's; the scanner and its real
 * decoder still read, in the browser, every symbol shown here.
 */
function readableQr(text: string): QrFrame {
  for (const mask of [undefined, 0, 1, 2, 3, 4, 5, 6, 7]) {
    const f = qrFrame(text, mask);
    if (decoderReads(f, text)) return f;
  }
  throw new Error(`no mask of the QR for ${text.slice(0, 12)}… is readable by @zxing/library`);
}

/** The camera of the page: a 640×640 canvas stream showing `__e2eShowQr(frame)`, or a refused permission. */
async function fakeCamera(page: Page, mode: 'ok' | 'denied' = 'ok'): Promise<void> {
  await page.addInitScript(
    ({ m, side }) => {
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d')!;
      let qr: QrFrame | null = null;
      const draw = () => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, side, side);
        if (!qr) return;
        ctx.fillStyle = '#000';
        for (let y = 0; y < qr.size; y++)
          for (let x = 0; x < qr.size; x++)
            if (qr.data[y * qr.size + x])
              ctx.fillRect(qr.off + x * qr.cell, qr.off + y * qr.cell, qr.cell, qr.cell);
      };
      setInterval(draw, 100);
      (window as unknown as { __e2eShowQr: (q: QrFrame) => void }).__e2eShowQr = (q) => {
        qr = q;
        draw();
      };
      const media = navigator.mediaDevices ?? ({} as MediaDevices);
      media.getUserMedia = async () => {
        if (m === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
        draw();
        return canvas.captureStream(15);
      };
      if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: media });
    },
    { m: mode, side: FRAME },
  );
}

async function showQr(page: Page, text: string): Promise<void> {
  await page.evaluate(
    (q) => (window as unknown as { __e2eShowQr: (q: QrFrame) => void }).__e2eShowQr(q),
    readableQr(text),
  );
}

function account(fake: FakeServer, vehicles: FPassAccount['vehicles'] = []): FPassAccount {
  return fake.addPassAccount({
    id: randomUUID(),
    secret: randomBytes(32).toString('base64url'),
    phone: PHONE,
    firstName: FIRST,
    status: 'active',
    vehicles,
  });
}

const VEHICLE = {
  id: randomUUID(),
  digits: '7310',
  letters_ar: 'ر س ص',
  letters_en: 'R S X',
  make: 'hyundai',
  model: 'سوناتا',
  color: 'silver',
};

/** The QR of C-11 now (+ steps: a phone clock off by that much). */
const passOf = (a: FPassAccount, vehicleId: string | null, offset = 0) =>
  generatePassToken({ secret: a.secret, accountId: a.id, vehicleId, step: passStep(fakeNowMs()) + offset });

function newIntake(fake: FakeServer, eventId: string = EVENT_R1) {
  startDuty(fake, 'DRV1');
  const created = fake.exec('DRV1', 'POST /v1/tickets', {}, { event_id: eventId });
  return { ticketId: created.ticket.id as string, n: created.ticket.display_number as number };
}

async function openScanner(page: Page) {
  await page.getByRole('button', { name: 'مسح بطاقة العميل' }).click();
  const sheet = page.getByRole('dialog', { name: 'مسح بطاقة العميل' });
  await expect(sheet.locator('[data-pass-scanner="scanning"]')).toBeVisible({ timeout: 15_000 });
  return sheet;
}

test.describe('functional (390)', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'mobile-390', 'functional flow: checked at 390 px only');
  });

  test('O-01: the pass fills the vehicle and links the account; D-05 → D-06 → D-07 without WhatsApp', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const fake = createFake();
    const a = account(fake, [VEHICLE]);
    const { ticketId, n } = newIntake(fake);
    const { page } = await actorPage(browser, fake, 'DRV1');
    await fakeCamera(page);
    await page.goto(`/d/intake/${ticketId}/vehicle`);
    // the included event: «مشمول» from the start (O-02)
    await expect(page.locator('[data-entitlement-badge]')).toContainText('مشمول');
    await expect(
      page.getByText('إن كانت لدى العميل بطاقة دخول في التطبيق، امسحها لتعبئة السيارة وربط الزيارة بحسابه.'),
    ).toBeVisible();

    const sheet = await openScanner(page);
    await expect(sheet.getByText('وجّه الكاميرا إلى رمز بطاقة الدخول في جوال العميل.')).toBeVisible();
    // another QR (a WhatsApp link) is not sent
    await showQr(page, 'https://wa.me/966500000000?text=K7Q29F');
    await expect(
      sheet.getByText('هذا الرمز ليس بطاقة دخول. اطلب من العميل فتح «بطاقة الدخول» في التطبيق.'),
    ).toBeVisible({ timeout: 15_000 });
    expect(fake.callsTo('POST /v1/tickets/intake-pass')).toHaveLength(0);

    const token = passOf(a, VEHICLE.id);
    await showQr(page, token);
    await expect(sheet).toHaveCount(0, { timeout: 25_000 });
    const [call] = fake.callsTo('POST /v1/tickets/intake-pass');
    expect(call?.body).toEqual({ pass_token: token, ticket_id: ticketId, expected_version: 1 });
    expect(call?.headers['idempotency-key']).toBeTruthy();

    const card = page.locator('[data-pass-linked]');
    await expect(card).toContainText('بطاقة العميل');
    await expect(card).toContainText(`العميل: ${FIRST}`);
    await expect(card).toContainText('05•••••123');
    await expect(card).toContainText('عُبّئت السيارة من حساب العميل. راجعها قبل المتابعة.');
    await expect(card).toContainText('يتابع العميل زيارته في التطبيق، ولا تُرسل له رسالة واتساب.');
    await expect(page.locator('#plate-digits')).toHaveValue('7310');
    await expect(page.getByLabel('الشركة المصنعة')).toHaveValue('hyundai');
    // the channel choice gives way to the card: no number, no consent, no stub
    await expect(page.locator('[data-field="channel"]')).toHaveCount(0);
    await expect(page.getByLabel('جوال العميل', { exact: true })).toHaveCount(0);
    expect(fake.world.tickets.find((t) => t.id === ticketId)).toMatchObject({ channel: 'app' });

    const step1 = await pressCommand(
      fake,
      'PATCH /v1/tickets/:ticketId/intake',
      page.locator('#intake-next'),
    );
    expect(step1.body).not.toHaveProperty('channel');
    expect(step1.body).not.toHaveProperty('customer_phone');
    expect(step1.body).not.toHaveProperty('paper_serial');
    await expect(page).toHaveURL(/\/key-photos$/);
    await page.getByLabel('رقم علاقة المفتاح').fill('58');
    for (const angle of REQUIRED_ANGLES) await page.getByLabel(`تصوير ${angle}`).setInputFiles(PHOTO);
    await expect(page.getByRole('heading', { name: 'صور الحالة (4 من 4)' })).toBeVisible({ timeout: 20_000 });
    await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'));
    // D-07: the app note, no WhatsApp link, «متابعة إلى الصف»
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`تذكرة التطبيق · #${n}`);
    await expect(
      page.getByText('العميل يتابع زيارته في التطبيق، ولا تُرسل لهذه التذكرة رسائل واتساب.'),
    ).toBeVisible();
    expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')).toHaveLength(0);
    expect(fake.world.tickets.find((t) => t.id === ticketId)?.wa_link_status).toBe('none');
    expectCommandContract(fake, [
      'POST /v1/tickets/intake-pass',
      'PATCH /v1/tickets/:ticketId/intake',
      'POST /v1/tickets/:ticketId/submit-intake',
    ]);
  });

  test('O-01: an expired pass is refused with «امسح مجددًا»; a vehicle not in the account is entered by hand', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const fake = createFake();
    const a = account(fake); // no vehicle in the account
    const { ticketId } = newIntake(fake, EVENT_R2);
    const { page } = await actorPage(browser, fake, 'DRV1');
    await fakeCamera(page);
    await page.goto(`/d/intake/${ticketId}/vehicle`);
    // the per-vehicle event: the intake driver sees «يدفع عند التسليم» (the fee is not in his projection, O-02)
    await expect(page.locator('[data-entitlement-badge]')).toContainText('يدفع عند التسليم');
    // the driver typed the plate before the customer showed the pass
    await page.locator('#plate-digits').fill('4321');

    const sheet = await openScanner(page);
    await showQr(page, passOf(a, null, -3));
    await expect(
      sheet.getByText('انتهت صلاحية بطاقة الدخول. امسح البطاقة الظاهرة الآن في جوال العميل.'),
    ).toBeVisible({ timeout: 15_000 });
    // the refused code still on the screen is not sent again; the customer's phone then shows the current one
    await sheet.getByRole('button', { name: 'امسح مجددًا' }).click();
    await expect(sheet.locator('[data-pass-scanner="scanning"]')).toBeVisible({ timeout: 15_000 });
    expect(fake.callsTo('POST /v1/tickets/intake-pass')).toHaveLength(1);
    await showQr(page, passOf(a, randomUUID()));
    await expect(sheet).toHaveCount(0, { timeout: 25_000 });
    expect(fake.callsTo('POST /v1/tickets/intake-pass').map((c) => c.status)).toEqual([410, 200]);

    const card = page.locator('[data-pass-linked]');
    await expect(card).toContainText('السيارة المختارة ليست في حساب العميل. أكمل بياناتها يدويًا.');
    // what the driver typed stays
    await expect(page.locator('#plate-digits')).toHaveValue('4321');

    // «استخدم واتساب أو تذكرة ورقية بدلًا من ذلك»: the channel choice is back, «التالي» sends it (the server
    // unlinks the account)
    await card.getByRole('button', { name: 'استخدم واتساب أو تذكرة ورقية بدلًا من ذلك' }).click();
    await expect(page.locator('[data-field="channel"]')).toBeVisible();
    await page.getByRole('radio', { name: 'تذكرة ورقية' }).click();
    await page.getByLabel('رقم التذكرة الورقية').fill('004599');
    for (const letter of ['ب B', 'ح J', 'د D'])
      await page.getByRole('button', { name: letter, exact: true }).click();
    await page.getByLabel('الشركة المصنعة').selectOption('toyota');
    await page.getByRole('radio', { name: 'أبيض' }).click();
    const step1 = await pressCommand(
      fake,
      'PATCH /v1/tickets/:ticketId/intake',
      page.locator('#intake-next'),
    );
    expect(step1.body).toMatchObject({ channel: 'paper', paper_serial: '004599', customer_phone: null });
    expect(fake.world.tickets.find((t) => t.id === ticketId)).toMatchObject({
      channel: 'paper',
      customer_phone: null,
    });
  });

  test('O-01: a refused camera says so; the manual intake stays', async ({ browser }) => {
    const fake = createFake();
    const { ticketId } = newIntake(fake);
    const { page } = await actorPage(browser, fake, 'DRV1');
    await fakeCamera(page, 'denied');
    await page.goto(`/d/intake/${ticketId}/vehicle`);
    await page.getByRole('button', { name: 'مسح بطاقة العميل' }).click();
    const sheet = page.getByRole('dialog', { name: 'مسح بطاقة العميل' });
    await expect(
      sheet.getByText('لا إذن باستخدام الكاميرا. اسمح بها من إعدادات المتصفح ثم حاول مجددًا.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(sheet.getByRole('button', { name: 'امسح مجددًا' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-field="channel"]')).toBeVisible();
    expect(fake.callsTo('POST /v1/tickets/intake-pass')).toHaveLength(0);
  });
});

test('layout (360/390/430): D-05 with the linked pass card and the entitlement badge', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const fake = createFake();
  const a = account(fake, [VEHICLE]);
  const { ticketId } = newIntake(fake);
  const t = fake.world.tickets.find((x) => x.id === ticketId)!;
  fake.exec(
    'DRV1',
    'POST /v1/tickets/intake-pass',
    {},
    { pass_token: passOf(a, VEHICLE.id), ticket_id: ticketId, expected_version: t.version },
  );
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await expect(page.locator('[data-pass-linked]')).toContainText('عميل التطبيق');
  await expect(page.locator('[data-entitlement-badge]')).toContainText('مشمول');
  await expect(page.locator('#plate-digits')).toHaveValue('7310');
  await expectMobileLayout(page);
});
