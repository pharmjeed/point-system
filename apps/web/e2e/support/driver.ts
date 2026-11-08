import { deflateSync } from 'node:zlib';
import { expect, type Locator, type Page } from '@playwright/test';
import type { CommandLog, LoggedCall } from './commandLog';
import { SEED_IDS, type FakeServer, type SeedUserKey } from './fake';

/**
 * Driver-flow helpers for the e2e specs: a camera photo, the command-press contract (PNT-035 acceptance 2),
 * D-03 from the UI, and API-level arrangements through the fake (`fake.exec`) so a spec can start at D-08,
 * D-10 or D-11 with a consistent world. The press checks take any `CommandLog`: the fake backend, or the
 * browser-side log of a page talking to the real API (PNT-036).
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function crc32(bytes: Buffer): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A small RGB PNG (solid colour) built in memory, so no binary fixture is checked in. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A photo «from the camera»: decoded and re-encoded to JPEG by the app (02 D-06). */
export const PHOTO = { name: 'camera.png', mimeType: 'image/png', buffer: png(64, 48, [40, 120, 200]) };

export const REQUIRED_ANGLES = ['الأمام', 'الخلف', 'الجانب الأيسر', 'الجانب الأيمن'];

let pressSeq = 0;

/**
 * Presses a command button and proves the contract: while the (delayed) reply is pending the button —
 * or `pending`, the one that carries the state (a dialog closes and the page button spins) — is disabled
 * and busy; a second press sends nothing; exactly one request reaches `route` with a UUIDv4
 * Idempotency-Key, and its reply has the expected status. Returns that call.
 */
export async function pressCommand(
  log: CommandLog,
  route: string,
  button: Locator,
  options: { pending?: Locator; delayMs?: number; expectStatus?: number } = {},
): Promise<LoggedCall> {
  const page = button.page();
  pressSeq += 1;
  const tag = `press-${pressSeq}`;
  // the label turns into «جارٍ…» while pending: follow the same DOM node, not the name
  await (options.pending ?? button).evaluate((el, t) => el.setAttribute('data-e2e-press', t), tag);
  const pending = page.locator(`[data-e2e-press="${tag}"]`);
  const before = log.callsTo(route).length;
  log.delayNext(route, options.delayMs ?? 700);
  await button.click();
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  await pending.click({ force: true, timeout: 1000 }).catch(() => undefined); // a second press while pending
  await expect.poll(() => log.callsTo(route).length, { timeout: 15_000 }).toBe(before + 1);
  const call = log.callsTo(route).at(-1) as LoggedCall;
  await expect.poll(() => call.status, { timeout: 15_000, message: `${route} answered` }).not.toBe(0);
  await page.waitForTimeout(300);
  expect(log.callsTo(route), `${route}: one request per press`).toHaveLength(before + 1);
  expect(call.headers['idempotency-key'], `${route} Idempotency-Key`).toMatch(UUID_V4);
  expect(call.headers['x-requested-with']).toBe('point-web');
  if (options.expectStatus !== undefined) expect(call.status, route).toBe(options.expectStatus);
  else {
    expect(call.status, `${route} succeeded`).toBeGreaterThanOrEqual(200);
    expect(call.status, `${route} succeeded`).toBeLessThan(300);
  }
  return call;
}

/** D-03 from the UI: «بدء الوردية» → «البدء دون اختبار» (no audio test in headless runs) → D-04. */
export async function startDutyFromUi(log: CommandLog, page: Page): Promise<void> {
  await page.goto('/d/start');
  await page.getByRole('button', { name: 'بدء الوردية' }).click();
  await pressCommand(
    log,
    'POST /v1/me/duty/start',
    page.getByRole('alertdialog').getByRole('button', { name: 'البدء دون اختبار' }),
    { pending: page.locator('#duty-start') },
  );
  await expect(page).toHaveURL(/\/d$/);
}

// ---------------------------------------------------------------- API-level arrangements (fake only)

export const EVENT_R1 = SEED_IDS.events['EVT-R1'];
export const EVENT_R2 = SEED_IDS.events['EVT-R2'];

export function startDuty(fake: FakeServer, as: SeedUserKey): void {
  fake.exec(as, 'POST /v1/me/duty/start', {}, {});
}

/** Uploads one inspection photo the way the app does (request → PUT bytes → complete). */
export function uploadPhoto(fake: FakeServer, as: SeedUserKey, ticketId: string, kind: string): void {
  const bytes = Buffer.from([0xff, 0xd8, 0xff]);
  const { media } = fake.exec(
    as,
    'POST /v1/tickets/:ticketId/media',
    { ticketId },
    {
      kind,
      content_type: 'image/jpeg',
      byte_size: bytes.length,
    },
  );
  fake.storage.set(media.id, { bytes, contentType: 'image/jpeg' });
  const row = fake.world.media.find((m) => m.id === media.id);
  if (row) row.received_bytes = bytes.length;
  fake.exec(as, 'POST /v1/media/:mediaId/complete', { mediaId: media.id }, {});
}

export interface Arranged {
  ticketId: string;
  displayNumber: number;
  parkTaskId: string;
}

/**
 * A ticket submitted by `as` (D-05 + D-06 done): the park task is in progress. Paper by default; `whatsapp`
 * (the customer's E.164) links directly with the verbal consent, and W-01 is accepted unless `linked: false`.
 */
export function arrangeSubmitted(
  fake: FakeServer,
  as: SeedUserKey,
  options: {
    eventId?: string;
    serial?: string;
    keyTag?: string;
    photos?: boolean;
    whatsapp?: string;
    linked?: boolean;
  } = {},
): Arranged {
  const created = fake.exec(as, 'POST /v1/tickets', {}, { event_id: options.eventId ?? EVENT_R1 });
  const ticketId: string = created.ticket.id;
  const channel = options.whatsapp
    ? {
        channel: 'whatsapp',
        customer_phone: options.whatsapp,
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
      }
    : { channel: 'paper', paper_serial: options.serial ?? '004522' };
  const patched = fake.exec(
    as,
    'PATCH /v1/tickets/:ticketId/intake',
    { ticketId },
    {
      expected_version: created.ticket.version,
      ...channel,
      plate: { country: 'SA', digits: '5678', letters_ar: 'ر س ص', letters_en: 'R S X' },
      vehicle: { make: 'chevrolet', model: 'تاهو', color: 'black' },
      key_tag: options.keyTag ?? '61',
    },
  );
  if (options.photos !== false)
    for (const kind of ['photo_front', 'photo_rear', 'photo_left', 'photo_right'])
      uploadPhoto(fake, as, ticketId, kind);
  fake.exec(
    as,
    'POST /v1/tickets/:ticketId/submit-intake',
    { ticketId },
    {
      expected_version: patched.version,
      acknowledge_incomplete_inspection: options.photos === false,
    },
  );
  if (options.whatsapp && options.linked !== false) fake.whatsapp.w01(ticketId, 'linked');
  return { ticketId, displayNumber: created.ticket.display_number, parkTaskId: created.task.id };
}

/** Completes `as`'s park task in `spot` / `slot` (labels of RMS: zone A «A-01»…, board «لوحة 1» «1»…). */
export function parkTask(
  fake: FakeServer,
  as: SeedUserKey,
  taskId: string,
  spot: string,
  slot: string,
): void {
  const spotRow = fake.world.spots.find((x) => x.label === spot && x.venue_id === SEED_IDS.venues.RMS);
  const slotRow = fake.world.slots.find((x) => x.label === slot && x.venue_id === SEED_IDS.venues.RMS);
  const task = fake.world.tasks.find((k) => k.id === taskId);
  fake.exec(
    as,
    'POST /v1/tasks/:taskId/complete-parking',
    { taskId },
    { parking_spot_id: spotRow?.id, key_slot_id: slotRow?.id, expected_version: task?.version },
  );
}

/** Submitted and parked in `spot` / `slot` (default A-10 / 20). */
export function arrangeParked(
  fake: FakeServer,
  as: SeedUserKey,
  options: Parameters<typeof arrangeSubmitted>[2] & { spot?: string; slot?: string } = {},
): Arranged {
  const arranged = arrangeSubmitted(fake, as, options);
  parkTask(fake, as, arranged.parkTaskId, options.spot ?? 'A-10', options.slot ?? '20');
  return arranged;
}

/** A retrieval request on behalf of the customer (07 `POST /tickets/{id}/retrievals`, SUP-R by default). */
export function requestRetrieval(fake: FakeServer, ticketId: string, as: SeedUserKey = 'SUP-R') {
  return fake.exec(
    as,
    'POST /v1/tickets/:ticketId/retrievals',
    { ticketId },
    { reason: 'العميل حضر بتذكرة ورقية' },
  );
}

/** The live offer of a ticket's open retrieval task. */
export function offerOf(fake: FakeServer, ticketId: string) {
  const task = fake.world.tasks.find(
    (k) => k.ticket_id === ticketId && k.type === 'retrieve' && k.status !== 'completed',
  );
  return fake.world.offers.find((o) => o.task_id === task?.id && o.status === 'active');
}

/** `as` accepts (or reserves as next) the live offer of `ticketId`; returns the retrieval task id. */
export function acceptOfferOf(fake: FakeServer, as: SeedUserKey, ticketId: string): string {
  const offer = offerOf(fake, ticketId);
  if (!offer) throw new Error(`no live offer for ticket ${ticketId}`);
  return fake.exec(as, 'POST /v1/task-offers/:offerId/accept', { offerId: offer.id }, {}).task.id;
}

/**
 * Parked by `as`, requested on behalf and accepted by `as` (the only free driver gets the single offer),
 * then moved on to `to`: `accepted` (D-10 key step), `key` (key picked up), `retrieving` or `ready` (D-11).
 */
export function arrangeRetrieval(
  fake: FakeServer,
  as: SeedUserKey,
  to: 'accepted' | 'key' | 'retrieving' | 'ready' = 'accepted',
  options: Parameters<typeof arrangeParked>[2] = {},
): Arranged & { taskId: string } {
  const arranged = arrangeParked(fake, as, options);
  requestRetrieval(fake, arranged.ticketId);
  const taskId = acceptOfferOf(fake, as, arranged.ticketId);
  const version = () => fake.world.tasks.find((k) => k.id === taskId)?.version;
  const steps: Array<[typeof to, string, () => Record<string, unknown>]> = [
    [
      'key',
      'POST /v1/tasks/:taskId/key-pickup',
      () => ({
        key_slot_id: fake.world.tickets.find((t) => t.id === arranged.ticketId)?.key_slot_id,
        expected_version: version(),
      }),
    ],
    ['retrieving', 'POST /v1/tasks/:taskId/start-retrieval', () => ({ expected_version: version() })],
    ['ready', 'POST /v1/tasks/:taskId/ready', () => ({ expected_version: version() })],
  ];
  const order = ['accepted', 'key', 'retrieving', 'ready'];
  for (const [step, route, body] of steps)
    if (order.indexOf(step) <= order.indexOf(to)) fake.exec(as, route, { taskId }, body());
  return { ...arranged, taskId };
}
