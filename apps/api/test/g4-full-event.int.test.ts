import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInvariants } from '@point/db';
import { SEED_IDS, seedKeySlotId, seedSpotId } from '@point/db/seed';
import {
  ANALYTICS_PII_DENYLIST,
  analyticsName,
  DOMAIN_EVENT_TYPES,
  findPiiValues,
  SERVER_ANALYTICS_PROPERTIES,
  type DomainEventType,
} from '@point/shared';
import {
  auditMonitoringJobs,
  auditMonitoringProjectors,
  EXPORTS_STORAGE,
  incidentsJobs,
  incidentsProjectors,
  metrics,
  OBJECT_STORAGE,
  paymentsReportsJobs,
  useCasesJobs,
  type InMemoryObjectStorage,
} from '@point/server';
import { createSessionCookie } from '@point/server/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomerApp, messagesTo, press, type CustomerApp } from './customer-harness.js';
import { CSRF, newKey, type SeedUserKey } from './harness.js';
import { err, expectConsistent, ok, one, rows, U, type Res } from './dispatch-fixtures.js';

/**
 * Gate G4 (16 PNT-093; 17 AC-12 / TC-036; 13 §10–§12): one full event of «قاعة ريماس» through the real routes,
 * the worker (every job handler and projector of the real worker, on the FakeClock) and the WhatsApp simulator
 * for the customers: the shift and the event are opened, seven drivers and a driving supervisor take in paper and
 * WhatsApp cars (photos uploaded through the media routes), the customers ask for their cars with «طلب السيارة»,
 * the supervisor asks for the paper ones; on the way: an early request, an incomplete inspection completed later
 * and another approved as an exception, a voided draft, a wrong phone corrected, an opt-out resumed by the button,
 * offers reminded and expired, an escalation acknowledged, a peak with reserved next tasks and view-only broadcasts
 * extended to a late driver, a reassignment and a withdrawal, a field cancel, a repark for an absent customer, a
 * locked handover code and the exceptional handover, a WhatsApp outage, a driver who loses his connection with a car,
 * a disabled and re-enabled driver, a transfer to «قاعة ليلتي» blocked by custody then completed, an outage handled on
 * the paper log and reconciled, cash and POS collections, a separate collection, a waiver, two reversals (with and
 * without a replacement), cash handovers with and without a difference; then start-closing → reconciliation →
 * close, and the shift is closed.
 *
 * Acceptance (PNT-093): no open custody, the amounts match (settlement = recorded payments; cash handed over = cash
 * collected + the recorded differences), the event is closed, the transfer succeeded, and the invariants hold:
 * docs/06_schema_invariants_test.sql (packages/db `runInvariants`), the 10 §14.1 / 11 §1.7 queries (`INVARIANTS`)
 * and infra/backup/consistency.sql. PNT-090 AC2 is proven on the same run: every domain event the run committed
 * — all 71 types of canon §7.1 — has exactly one `analytics_events` row, inside the 15 §3/§7 allow-list.
 */

const RMS = SEED_IDS.venues.RMS;
const LYL = SEED_IDS.venues.LYL;
const POOL_R = SEED_IDS.pools['POOL-R'];
const FEE = 2000;
const UID = U as Record<string, string>;
const uid = (k: string) => UID[k] ?? k;

/** 24×16 JPEG (the media module strips its EXIF/GPS on completion; 27 §DEC-36). */
const JPEG = Buffer.from(
  '/9j/4QFYRXhpZgAASUkqAAgAAAAJAA8BAgALAAAAkAAAABABAgAGAAAAigAAABIBAwABAAAABgAAABoBBQABAAAAegAAABsBBQABAAAAggAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAnAAAACWIBAABAAAA6gAAAAAAAAA4YwAA6AMAADhjAADoAwAAR1BTLTEARml4dHVyZUNhbQAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAABgAAAADoAQAAQAAABAAAAAAAAAABAABAAIAAgAAAE4AAAACAAUAAwAAADgBAAADAAIAAgAAAEUAAAAEAAUAAwAAACABAAAAAAAALgAAAAEAAAAoAAAAAQAAALAEAABkAAAAGAAAAAEAAAAqAAAAAQAAABAOAABkAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwANCQoLCggNCwoLDg4NDxMgFRMSEhMnHB4XIC4pMTAuKS0sMzpKPjM2RjcsLUBXQUZMTlJTUjI+WmFaUGBKUVJP/9sAQwEODg4TERMmFRUmTzUtNU9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P/8AAEQgAEAAYAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAF/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAEBv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIYCFqAAH//Z',
  'base64',
);
const PHOTO_KINDS = ['photo_front', 'photo_rear', 'photo_left', 'photo_right'] as const;

/** A car of the event as the test follows it. */
interface Car {
  key: string;
  ticketId: string;
  parkTaskId: string;
  displayNumber: number;
  channel: 'whatsapp' | 'paper';
  phone: string | null;
  serial: string | null;
  plateDigits: string;
  spotId: string | null;
  slotId: string | null;
  slotLabel: string | null;
  spotLabel: string | null;
  /** the open retrieve task and cycle, once requested */
  taskId?: string;
  cycleId?: string;
}

describe('G4 — a full event through the real routes, closed with nothing open and matching amounts (PNT-093)', () => {
  let w: CustomerApp;
  let storage: InMemoryObjectStorage;
  let eventId = '';
  let shiftId = '';
  const cars = new Map<string, Car>();
  /** cookies minted after a session revocation (transfer, disable) */
  const cookies = new Map<string, string>();
  /** drivers on duty: they send `POST /v1/me/heartbeat` as their PWA does every 15 s */
  const onDuty = new Set<string>();
  /** drivers whose phone lost the network (no heartbeat) */
  const silent = new Set<string>();
  const phones = new Set<string>();
  /** handover codes the customers received (W-05), for the leak scan */
  const codesSeen = new Set<string>();
  let spotSeq = 0;
  let slotSeq = 0;
  let serialSeq = 400;
  let plateSeq = 3100;

  // ------------------------------------------------------------------------------------------------ requests
  const cookieOf = async (as: string) => cookies.get(uid(as)) ?? (await w.sessionFor(as as SeedUserKey));
  async function cmd(
    as: string,
    method: 'post' | 'put' | 'patch',
    path: string,
    body: unknown = {},
    key: string | null = newKey(),
  ): Promise<Res> {
    const server = request(w.app.getHttpServer());
    let req = server[method](path)
      .set(CSRF)
      .set('Cookie', await cookieOf(as));
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send(body as object);
  }
  async function get(as: string, path: string): Promise<Res> {
    return request(w.app.getHttpServer())
      .get(path)
      .set('Cookie', await cookieOf(as));
  }
  /** a fresh session after the old ones were revoked (09 §9.5: transfer, disable) */
  async function relogin(as: string) {
    cookies.set(
      uid(as),
      (await createSessionCookie(w.db, uid(as), { now: w.clock.now(), hours: 48 })).cookie,
    );
  }

  // ------------------------------------------------------------------------------------------------ the clock
  const lastBeat = new Map<string, number>();
  async function heartbeats(force = false) {
    const now = w.clock.now().getTime();
    for (const d of onDuty) {
      if (silent.has(d)) continue;
      if (!force && now - (lastBeat.get(d) ?? 0) < 15_000) continue;
      const r = await cmd(
        d,
        'post',
        '/v1/me/heartbeat',
        { visible: true, audio_unlocked: true, ws_connected: true, app_version: 'g4' },
        null,
      );
      if (r.status === 401 && r.body?.error?.code === 'AUTH_SESSION_REVOKED') {
        onDuty.delete(d); // transfer or disable: the PWA goes back to the sign-in screen (09 §9.5)
        continue;
      }
      expect(r.status, `heartbeat of ${d}: ${JSON.stringify(r.body)}`).toBe(200);
      lastBeat.set(d, now);
    }
  }
  /** the statuses Meta would send for every accepted message (the per-ticket ordering gate needs them) */
  async function deliverStatuses(): Promise<number> {
    let n = 0;
    for (const m of await w.sim.client.listMessages({})) {
      if (m.statuses.length > 0) continue;
      await w.sim.client.emitStatuses({ wamid: m.wamid, statuses: ['sent', 'delivered'], timestamp: w.ts() });
      n++;
    }
    return n;
  }
  /** runs the worker until nothing is due, delivering statuses and following deferred sends (≤ 10 s) */
  async function pump() {
    for (let i = 0; i < 12; i++) {
      const done = await w.drain();
      const delivered = await deliverStatuses();
      if (done === 0 && delivered === 0) {
        const next = (
          await w.db.query<{ at: Date | null }>(
            `SELECT min(available_at) AS at FROM outbox_events WHERE status = 'pending' AND type = 'job.wa_send' AND available_at > $1`,
            [w.clock.now()],
          )
        ).rows[0]?.at;
        if (!next || new Date(next).getTime() - w.clock.now().getTime() > 10_000) return;
        w.clock.set(new Date(next));
        await heartbeats();
      }
    }
  }
  /** time passes on the FakeClock in steps of ≤ `step` s: heartbeats, then the worker (timers fire in time) */
  async function tick(seconds: number, step = 5) {
    for (let done = 0; done < seconds; done += step) {
      w.clock.advanceSeconds(Math.min(step, seconds - done));
      await heartbeats();
      await pump();
    }
  }

  // ------------------------------------------------------------------------------------------------ drivers
  async function startDuty(as: string, body: Record<string, unknown> = {}) {
    ok(await cmd(as, 'post', '/v1/me/duty/start', body), 201);
    onDuty.add(as);
    lastBeat.set(as, w.clock.now().getTime());
    await pump();
  }
  async function brk(as: string, active: boolean) {
    ok(await cmd(as, 'post', '/v1/me/duty/break', { active }));
    await pump();
  }

  // ------------------------------------------------------------------------------------------------ intake
  async function uploadPhotos(
    as: string,
    ticketId: string,
    kinds: readonly string[],
    capturedAt: Date = w.clock.now(),
  ) {
    for (const kind of kinds) {
      const r = ok(
        await cmd(as, 'post', `/v1/tickets/${ticketId}/media`, {
          kind,
          content_type: 'image/jpeg',
          byte_size: JPEG.length,
          captured_at: capturedAt.toISOString(),
        }),
        201,
      );
      expect(storage.upload(r.upload, JPEG).status).toBe(200);
      ok(await cmd(as, 'post', `/v1/media/${r.media.id}/complete`, {}));
    }
  }
  const nextSpot = () => {
    spotSeq++;
    const label =
      spotSeq <= 30 ? `A-${String(spotSeq).padStart(2, '0')}` : `B-${String(spotSeq - 30).padStart(2, '0')}`;
    return { spotId: seedSpotId(label), spotLabel: label };
  };
  const nextSlot = () => {
    slotSeq++;
    return { slotId: seedKeySlotId('RMS', slotSeq), slotLabel: String(slotSeq) };
  };

  /** POST /v1/tickets → PATCH intake → photos through the media routes → submit (WhatsApp: W-01 follows). */
  async function intake(
    key: string,
    as: string,
    o: {
      channel: 'whatsapp' | 'paper';
      phone?: string;
      photos?: number;
      submit?: boolean;
      event?: string;
    },
  ): Promise<Car> {
    const created = ok(
      await cmd(as, 'post', '/v1/tickets', { event_id: o.event ?? eventId, channel: o.channel }),
      201,
    );
    const ticketId: string = created.ticket.id;
    const plateDigits = String(plateSeq++);
    const serial = o.channel === 'paper' ? `G4-${serialSeq++}` : null;
    await tick(20);
    const patched = ok(
      await cmd(as, 'patch', `/v1/tickets/${ticketId}/intake`, {
        expected_version: created.ticket.version,
        plate: { digits: plateDigits, letters_ar: 'ر س ص' },
        vehicle: { make: 'تويوتا', model: 'لاندكروزر', color: 'أبيض', type: 'suv' },
        key_tag: `KT-${plateDigits}`,
        ...(o.channel === 'whatsapp'
          ? { customer_phone: o.phone, consent: { method: 'verbal_staff_confirmed', confirmed: true } }
          : { paper_serial: serial }),
      }),
    );
    expect(patched.status).toBe('received');
    await tick(20);
    await uploadPhotos(as, ticketId, PHOTO_KINDS.slice(0, o.photos ?? 4));
    const car: Car = {
      key,
      ticketId,
      parkTaskId: created.task.id,
      displayNumber: created.ticket.display_number,
      channel: o.channel,
      phone: o.phone ?? null,
      serial,
      plateDigits,
      spotId: null,
      slotId: null,
      slotLabel: null,
      spotLabel: null,
    };
    cars.set(key, car);
    if (o.phone) phones.add(o.phone);
    if (o.submit === false) return car;
    const version = ok(await get(as, `/v1/tickets/${ticketId}`)).version;
    const submitted = ok(
      await cmd(as, 'post', `/v1/tickets/${ticketId}/submit-intake`, {
        expected_version: version,
        ...((o.photos ?? 4) < 4 ? { acknowledge_incomplete_inspection: true } : {}),
      }),
    );
    expect(submitted.status).toBe('parking');
    await pump();
    return car;
  }

  /** complete-parking in the next free spot and key slot of the venue */
  async function park(as: string, car: Car, o: { taskId?: string; status?: string } = {}) {
    await tick(60);
    const s = nextSpot();
    const k = nextSlot();
    const r = ok(
      await cmd(as, 'post', `/v1/tasks/${o.taskId ?? car.parkTaskId}/complete-parking`, {
        parking_spot_id: s.spotId,
        key_slot_id: k.slotId,
      }),
    );
    expect(r.ticket.status).toBe(o.status ?? 'parked');
    Object.assign(car, s, k);
    await pump();
    return r;
  }

  // ------------------------------------------------------------------------------------------------ retrieval
  /** the live round of a task with its recipients */
  async function roundOf(taskId: string) {
    const offer = await w.db.query<{ id: string; mode: string; round_no: number }>(
      `SELECT id, mode, round_no FROM task_offers WHERE task_id = $1 AND status = 'active'`,
      [taskId],
    );
    const o = offer.rows[0];
    if (!o) return null;
    const recipients = await rows<{ user_id: string; eligible_as: string }>(
      w.db,
      `SELECT user_id, eligible_as FROM offer_recipients WHERE offer_id = $1 ORDER BY user_id`,
      [o.id],
    );
    return { ...o, recipients };
  }
  const nameOf = (userId: string) => Object.entries(UID).find(([, id]) => id === userId)?.[0] ?? userId;

  /** the customer presses «طلب السيارة» on his latest W-01 */
  async function customerAsks(car: Car) {
    await press(w, car.phone!);
    await pump();
    return openTask(car);
  }
  /** the supervisor asks on behalf of a paper customer at the gate */
  async function staffAsks(car: Car, as = 'SUP-R') {
    const r = ok(
      await cmd(as, 'post', `/v1/tickets/${car.ticketId}/retrievals`, { reason: 'العميل عند البوابة' }),
      201,
    );
    car.taskId = r.task.id;
    car.cycleId = r.cycle.id;
    await pump();
    return r;
  }
  async function openTask(car: Car) {
    const t = await one<{ id: string; cycle_id: string; status: string }>(
      w.db,
      `SELECT id, cycle_id, status FROM tasks WHERE ticket_id = $1 AND type = 'retrieve' AND status NOT IN ('completed','canceled')`,
      [car.ticketId],
    );
    car.taskId = t.id;
    car.cycleId = t.cycle_id;
    return t;
  }
  /** the recipient accepts the live round of the car's retrieval (single, or broadcast as accept/reserve_next) */
  async function accept(as: string, car: Car) {
    const round = await roundOf(car.taskId!);
    expect(round, `no live round for ${car.key}`).not.toBeNull();
    expect(round!.recipients.map((r) => r.user_id)).toContain(uid(as));
    const r = ok(await cmd(as, 'post', `/v1/task-offers/${round!.id}/accept`, {}));
    await pump();
    return r;
  }
  /** key pickup → start → ready, with the minutes of a real retrieval in between */
  async function bring(as: string, car: Car) {
    await tick(30);
    ok(await cmd(as, 'post', `/v1/tasks/${car.taskId}/key-pickup`, { key_slot_id: car.slotId }));
    await tick(20);
    ok(await cmd(as, 'post', `/v1/tasks/${car.taskId}/start-retrieval`, {}));
    await tick(90, 10);
    const r = ok(await cmd(as, 'post', `/v1/tasks/${car.taskId}/ready`, {}));
    await pump();
    return r;
  }
  /** the code the customer received in W-05 (read from the simulator's outbound log only) */
  async function codeOf(car: Car) {
    const code = await w.sim.client.claimCode(car.phone!);
    expect(code).toMatch(/^[0-9]{6}$/);
    codesSeen.add(code!);
    return code!;
  }
  async function handOver(as: string, car: Car, payment?: Record<string, unknown> | null) {
    await tick(20);
    const verification =
      car.channel === 'whatsapp'
        ? { method: 'code', code: await codeOf(car) }
        : { method: 'paper_stub', paper_serial: car.serial };
    const r = ok(
      await cmd(as, 'post', `/v1/tickets/${car.ticketId}/handover`, {
        verification,
        ...(payment === undefined ? {} : { payment }),
      }),
    );
    expect(r.ticket.status).toBe('delivered');
    await pump();
    return r;
  }
  const CASH = { method: 'cash', amount_halalas: FEE };
  const POS = (ref: string) => ({ method: 'pos', amount_halalas: FEE, pos_reference: ref });

  /** point_analytics_rejected_total{source="server"} by reason (refused rows and values stored as null) */
  const serverRejections = async () => {
    const out: Record<string, number> = {};
    for (const v of (await metrics.analyticsRejected.get()).values)
      if (v.labels.source === 'server') out[String(v.labels.reason)] = v.value;
    return out;
  };
  let rejectedBefore: Record<string, number> = {};

  // ------------------------------------------------------------------------------------------------ setup
  beforeAll(async () => {
    rejectedBefore = await serverRejections();
    w = await createCustomerApp();
    storage = w.app.get<InMemoryObjectStorage>(OBJECT_STORAGE);
    // the real worker's other handlers and projectors (apps/worker/src/handlers.ts): incidents, payments and
    // reports, audit-monitoring (the AnalyticsProjector), the use-cases (job.transfer_activate)
    for (const h of [
      ...incidentsJobs(),
      ...paymentsReportsJobs({ storage: w.app.get(EXPORTS_STORAGE) }),
      ...auditMonitoringJobs(),
      ...useCasesJobs(),
    ])
      w.dispatcher.register(h);
    for (const p of [...incidentsProjectors(), ...auditMonitoringProjectors({ appVersion: 'g4-test' })])
      w.dispatcher.registerProjector(p);
  }, 120_000);
  afterAll(async () => w?.close());

  // ============================================================================================== opening
  it('opening (19:00 Riyadh): yesterday’s shift closed, the event and its shift opened, the drivers on duty', async () => {
    // the shift left open by the previous night is closed (nobody on duty), the evening's shift is opened
    const old = SEED_IDS.shifts['SHF-R'];
    expect(ok(await cmd('SUP-R', 'post', `/v1/shifts/${old}/close`, {})).status).toBe('closed');
    const now = w.clock.now();
    const shift = ok(
      await cmd('SUP-R', 'post', `/v1/venues/${RMS}/shifts`, {
        name: 'وردية حفل الخميس',
        starts_at: now.toISOString(),
        ends_at: new Date(now.getTime() + 6 * 3600_000).toISOString(),
      }),
      201,
    );
    shiftId = shift.id;
    expect(ok(await cmd('SUP-R', 'post', `/v1/shifts/${shiftId}/open`, {})).status).toBe('open');

    const ev = ok(
      await cmd('SUP-R', 'post', `/v1/venues/${RMS}/events`, {
        name_ar: 'حفل زفاف — بوابة G4',
        host_name: 'أسرة المضيف',
        event_date: '2026-10-27',
        starts_at: now.toISOString(),
        ends_at: new Date(now.getTime() + 5 * 3600_000).toISOString(),
        pricing_mode: 'per_vehicle',
        fee_halalas: FEE,
        allowed_payment_methods: ['cash', 'pos'],
      }),
      201,
    );
    eventId = ev.id;
    expect(ev).toMatchObject({ status: 'draft', dispatch_pool_id: POOL_R });
    expect(ok(await cmd('SUP-R', 'post', `/v1/events/${eventId}/open`, {})).status).toBe('open');

    // DRV1 longest idle, then DRV2, DRV3, DRV4, DRV6 (DRV5 is late, SUP-RD drives when needed)
    for (const d of ['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV6']) {
      await startDuty(d);
      await tick(10);
    }
    const live = ok(await get('SUP-R', `/v1/events/${eventId}/operations`));
    expect(live.kpis.drivers_on_duty).toBe(5);
  });

  // ============================================================================================== arrivals
  it('arrivals: paper and WhatsApp intakes with photos through the media routes, and their exceptions', async () => {
    const k1 = await intake('K1', 'DRV1', { channel: 'whatsapp', phone: '+966551234567' });
    await park('DRV1', k1);
    const k2 = await intake('K2', 'DRV2', { channel: 'paper' });
    await park('DRV2', k2);
    const k3 = await intake('K3', 'DRV3', { channel: 'whatsapp', phone: '+966559876543' });
    await park('DRV3', k3);
    // W-01 carries the only button of the conversation and links the ticket on acceptance
    for (const car of [k1, k3]) {
      expect((await messagesTo(w, car.phone!)).map((m) => m.purpose)).toEqual(['W-01']);
      expect(
        (await one(w.db, `SELECT wa_link_status FROM tickets WHERE id = $1`, [car.ticketId])).wa_link_status,
      ).toBe('linked');
    }

    // K4: three photos (the fourth failed to upload): submitted incomplete, the alert is raised; the driver
    // uploads the fourth photo while parking → ticket.inspection_completed and the alert is resolved by the worker
    const takenAt = new Date(w.clock.now().getTime() + 30_000); // during the intake, before the submission
    const k4 = await intake('K4', 'DRV4', { channel: 'whatsapp', phone: '+966512340001', photos: 3 });
    const incomplete = await one(
      w.db,
      `SELECT id, status FROM alerts WHERE type = 'inspection_incomplete' AND ticket_id = $1`,
      [k4.ticketId],
    );
    expect(incomplete.status).toBe('open');
    await tick(30);
    // the photo taken during the intake reaches the server once the network is back (D-06 retry)
    await uploadPhotos('DRV4', k4.ticketId, ['photo_right'], takenAt);
    await pump();
    expect(
      (await one(w.db, `SELECT inspection_status FROM tickets WHERE id = $1`, [k4.ticketId]))
        .inspection_status,
    ).toBe('complete');
    expect((await one(w.db, `SELECT status FROM alerts WHERE id = $1`, [incomplete.id])).status).toBe(
      'resolved',
    );
    await park('DRV4', k4);

    // K5: the camera broke after three photos: the supervisor approves the inspection exception
    const k5 = await intake('K5', 'DRV6', { channel: 'paper', photos: 3 });
    ok(
      await cmd('SUP-R', 'post', `/v1/tickets/${k5.ticketId}/inspection-exception`, {
        reason: 'كاميرا جوال السائق تعطلت؛ فحص بصري موثق مع المشرف',
      }),
    );
    expect(
      (await one(w.db, `SELECT inspection_status FROM tickets WHERE id = $1`, [k5.ticketId]))
        .inspection_status,
    ).toBe('exception_approved');
    await park('DRV6', k5);

    // K6: the driver typed a wrong number; the customer got nothing, the number is corrected with a reason and
    // W-01 goes to the right number (the first one's button is stale)
    const k6 = await intake('K6', 'DRV1', { channel: 'whatsapp', phone: '+966512340003' });
    const v6 = ok(await get('DRV1', `/v1/tickets/${k6.ticketId}`)).version;
    ok(
      await cmd('DRV1', 'patch', `/v1/tickets/${k6.ticketId}/customer-phone`, {
        expected_version: v6,
        customer_phone: '0512340004',
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
        reason: 'العميل أعطى رقمًا خاطئًا وصحّحه عند البوابة',
      }),
    );
    k6.phone = '+966512340004';
    phones.add(k6.phone);
    await pump();
    expect((await messagesTo(w, '+966512340004')).map((m) => m.purpose)).toEqual(['W-01']);
    await park('DRV1', k6);

    // K7: a draft whose guest decided to park himself: the supervisor voids it, custody back to the customer
    const k7 = await intake('K7', 'DRV2', { channel: 'paper', submit: false });
    ok(
      await cmd('SUP-R', 'post', `/v1/tickets/${k7.ticketId}/void`, {
        reason: 'الضيف قرر صف سيارته بنفسه',
        custody_returned_to_customer: true,
      }),
    );
    expect((await one(w.db, `SELECT status FROM tickets WHERE id = $1`, [k7.ticketId])).status).toBe(
      'voided',
    );
    await pump();

    const k9 = await intake('K9', 'DRV4', { channel: 'paper' });
    await park('DRV4', k9);
    const k10 = await intake('K10', 'DRV6', { channel: 'whatsapp', phone: '+966512340006' });
    await park('DRV6', k10);
    // the driving supervisor joins the drivers for the rush
    await startDuty('SUP-RD');
    const k11 = await intake('K11', 'SUP-RD', { channel: 'paper' });
    await park('SUP-RD', k11);
    const k12 = await intake('K12', 'DRV2', { channel: 'whatsapp', phone: '+966512340007' });
    await park('DRV2', k12);
    const k13 = await intake('K13', 'DRV1', { channel: 'paper' });
    await park('DRV1', k13);
    const k14 = await intake('K14', 'DRV3', { channel: 'whatsapp', phone: '+966512340008' });
    await park('DRV3', k14);
    const k15 = await intake('K15', 'DRV6', { channel: 'paper' });
    await park('DRV6', k15);
    const k16 = await intake('K16', 'DRV4', { channel: 'whatsapp', phone: '+966512340010' });
    await park('DRV4', k16);

    // K8: a guest who leaves early presses «طلب السيارة» while his car is still being parked: one W-02, no
    // movement until complete-parking converts it with the press time (DEC-13)
    const k8 = await intake('K8', 'DRV3', { channel: 'whatsapp', phone: '+966512340005' });
    await tick(10);
    await press(w, k8.phone!);
    await pump();
    expect(
      (await one(w.db, `SELECT status, pending_retrieval_at FROM tickets WHERE id = $1`, [k8.ticketId]))
        .status,
    ).toBe('parking');
    await park('DRV3', k8, { status: 'requested' }); // converted with the press time
    const t8 = await openTask(k8);
    const cycle8 = await one(
      w.db,
      `SELECT requested_early, request_source FROM retrieval_cycles WHERE id = $1`,
      [t8.cycle_id],
    );
    expect(cycle8).toEqual({ requested_early: true, request_source: 'whatsapp' });
    const round8 = (await roundOf(t8.id))!;
    expect(round8.mode).toBe('single');
    const d8 = nameOf(round8.recipients[0]!.user_id);
    await accept(d8, k8);
    await bring(d8, k8);
    await handOver(d8, k8, CASH);
    expect((await messagesTo(w, k8.phone!)).map((m) => m.purpose)).toEqual([
      'W-01',
      'W-02',
      'W-04',
      'W-05',
      'W-06',
    ]);

    const open = await rows(
      w.db,
      `SELECT status, count(*)::int AS n FROM tickets WHERE event_id = $1 GROUP BY status ORDER BY status`,
      [eventId],
    );
    expect(open).toEqual([
      { status: 'delivered', n: 1 },
      { status: 'parked', n: 14 },
      { status: 'voided', n: 1 },
    ]);
  });

  // ============================================================================================== retrievals
  /** whoever the engine offered the car to (single round) accepts, brings it and hands it over */
  async function singleOfferTo(car: Car): Promise<string> {
    const round = (await roundOf(car.taskId!))!;
    expect(round, `no live round for ${car.key}`).toBeTruthy();
    expect(round.mode).toBe('single');
    return nameOf(round.recipients[0]!.user_id);
  }

  it('«إيقاف» then «طلب السيارة»: the consent resumes with the press and the car comes (K1)', async () => {
    const k1 = cars.get('K1')!;
    await w.sim.client.sendStop(k1.phone!, { timestamp: w.ts() });
    await pump();
    expect(
      (await one(w.db, `SELECT wa_link_status FROM tickets WHERE id = $1`, [k1.ticketId])).wa_link_status,
    ).toBe('opted_out');
    await tick(120, 10);
    await customerAsks(k1);
    expect(
      await one(w.db, `SELECT wa_link_status, status FROM tickets WHERE id = $1`, [k1.ticketId]),
    ).toEqual({
      wa_link_status: 'linked',
      status: 'requested',
    });
    const d = await singleOfferTo(k1);
    await accept(d, k1);
    await bring(d, k1);
    await handOver(d, k1, CASH);
    const purposes = (await messagesTo(w, k1.phone!)).map((m) => m.purpose ?? 'session');
    expect(purposes).toEqual(['W-01', 'session', 'W-02', 'W-04', 'W-05', 'W-06']); // W-12 is the session reply
  });

  it('an offer nobody answers: reminded, expired, offered to the next driver, escalated, acknowledged, then claimed (K3)', async () => {
    const k3 = cars.get('K3')!;
    await tick(30);
    await customerAsks(k3);
    const first = await singleOfferTo(k3);
    const queuedAt = (await one(w.db, `SELECT queued_at FROM tasks WHERE id = $1`, [k3.taskId]))
      .queued_at as Date;
    await tick(20); // 15 s: job.offer_remind
    expect(
      (await rows(w.db, `SELECT reminded_at FROM task_offers WHERE task_id = $1`, [k3.taskId]))[0]!
        .reminded_at,
    ).not.toBeNull();
    await tick(15); // 31.5 s: job.offer_expire → the silent driver rotates, the next longest idle gets it
    const second = await singleOfferTo(k3);
    expect(second).not.toBe(first);
    expect(
      await rows(w.db, `SELECT status, close_reason FROM task_offers WHERE task_id = $1 ORDER BY round_no`, [
        k3.taskId,
      ]),
    ).toEqual([
      { status: 'expired', close_reason: 'expired' },
      { status: 'active', close_reason: null },
    ]);
    // 60 s after queued_at with nobody accepting: task.escalated and the critical request_unaccepted alert
    const left = 60 - (w.clock.now().getTime() - new Date(queuedAt).getTime()) / 1000;
    await tick(Math.ceil(left), 1);
    const alert = await one(
      w.db,
      `SELECT id, severity, status FROM alerts WHERE type = 'request_unaccepted' AND task_id = $1`,
      [k3.taskId],
    );
    expect(alert).toMatchObject({ severity: 'critical', status: 'open' });
    const listed = ok(await get('SUP-R', `/v1/alerts?venue_id=${RMS}&type=request_unaccepted`));
    expect(listed.map((a: { id: string }) => a.id)).toContain(alert.id);
    ok(await cmd('SUP-R', 'post', `/v1/alerts/${alert.id}/acknowledge`, { note: 'أتصل بالسائق' }));
    await accept(second, k3);
    expect((await one(w.db, `SELECT status FROM alerts WHERE id = $1`, [alert.id])).status).toBe('resolved');
    await bring(second, k3);
    await handOver(second, k3, POS('AP3003'));
  });

  it('a field cancel at the gate, the second request, and a POS reference corrected by a reversal with replacement (K4)', async () => {
    const k4 = cars.get('K4')!;
    await tick(40);
    await customerAsks(k4);
    const d = await singleOfferTo(k4);
    await accept(d, k4);
    // the guest tells the supervisor at the gate that he stays a little longer
    const firstCycle = k4.cycleId!;
    const canceled = ok(
      await cmd('SUP-R', 'post', `/v1/retrieval-cycles/${firstCycle}/cancel`, {
        reason: 'العميل سيبقى وقتًا أطول',
      }),
    );
    expect(canceled.ticket.status).toBe('parked');
    await pump();
    expect((await messagesTo(w, k4.phone!)).map((m) => m.purpose)).toEqual(['W-01', 'W-02', 'W-07']);
    await tick(300, 10);
    await customerAsks(k4);
    expect(
      (await one(w.db, `SELECT cycle_no FROM retrieval_cycles WHERE id = $1`, [k4.cycleId])).cycle_no,
    ).toBe(2);
    const d2 = await singleOfferTo(k4);
    await accept(d2, k4);
    await bring(d2, k4);
    const done = await handOver(d2, k4, POS('AP4004'));
    // the terminal slip says AP4040: the supervisor reverses with the corrected reference (13 §7.2)
    const fixed = ok(
      await cmd('SUP-R', 'post', `/v1/payments/${done.payment.id}/reverse`, {
        reason: 'رقم مرجع الشبكة أُدخل خطأ',
        replacement: { method: 'pos', amount_halalas: FEE, pos_reference: 'AP4040' },
      }),
    );
    expect(fixed.reversed.status).toBe('reversed');
    expect(fixed.replacement).toMatchObject({
      status: 'recorded',
      pos_reference: 'AP4040',
      collected_by: { id: uid(d2) },
    });
    expect(
      (await one(w.db, `SELECT payment_status FROM tickets WHERE id = $1`, [k4.ticketId])).payment_status,
    ).toBe('collected');
    await pump();
  });

  it('a customer who does not come: ready_not_collected, repark (W-08), parked again, then delivered on the next press (K6)', async () => {
    const k6 = cars.get('K6')!;
    await customerAsks(k6);
    const d = await singleOfferTo(k6);
    await accept(d, k6);
    await bring(d, k6);
    await tick(610, 10); // ready.uncollected_alert_min = 10
    const alert = await one(
      w.db,
      `SELECT id, status FROM alerts WHERE type = 'ready_not_collected' AND ticket_id = $1`,
      [k6.ticketId],
    );
    expect(alert.status).toBe('open');
    const r = ok(
      await cmd('SUP-R', 'post', `/v1/tickets/${k6.ticketId}/repark`, { reason: 'العميل لم يحضر' }),
    );
    expect(r.ticket.status).toBe('reparking');
    expect(r.task).toMatchObject({ type: 'repark', status: 'in_progress', assignee: { id: uid(d) } });
    expect((await one(w.db, `SELECT status FROM alerts WHERE id = $1`, [alert.id])).status).toBe('resolved');
    await pump();
    await park(d, k6, { taskId: r.task.id });
    expect((await messagesTo(w, k6.phone!)).map((m) => m.purpose)).toEqual([
      'W-01',
      'W-02',
      'W-04',
      'W-05',
      'W-08',
    ]);
    await tick(240, 10);
    await customerAsks(k6);
    expect(
      (await one(w.db, `SELECT cycle_no FROM retrieval_cycles WHERE id = $1`, [k6.cycleId])).cycle_no,
    ).toBe(2);
    const d2 = await singleOfferTo(k6);
    await accept(d2, k6);
    await bring(d2, k6);
    await handOver(d2, k6, CASH);
  });

  const health = async () =>
    (await one(w.db, `SELECT health_status FROM whatsapp_channel WHERE is_active`)).health_status as string;

  it('the peak: two drivers with reserved next tasks, view-only broadcasts extended to a late driver, a WhatsApp outage, a separate collection, a locked code and the exceptional handover', async () => {
    // the others pray the ʿishāʾ: only DRV1 and DRV2 keep working
    for (const d of ['DRV3', 'DRV4', 'DRV6', 'SUP-RD']) await brk(d, true);
    const [k10, k12, k14, k16, k11, k5] = ['K10', 'K12', 'K14', 'K16', 'K11', 'K5'].map((k) =>
      cars.get(k)!,
    ) as [Car, Car, Car, Car, Car, Car];
    await customerAsks(k10);
    const a = await singleOfferTo(k10);
    await accept(a, k10);
    await tick(5);
    await customerAsks(k12);
    const b = await singleOfferTo(k12);
    expect(b).not.toBe(a);
    await accept(b, k12);

    // the provider goes down: the requests go on, the messages wait (12 §5.14)
    await w.sim.client.setChannel({ state: 'down', code: 190 });
    await tick(5);
    await customerAsks(k14);
    expect(await health()).toBe('down');
    let round = (await roundOf(k14.taskId!))!;
    expect(round.mode).toBe('broadcast');
    expect(round.recipients).toEqual(
      [
        { user_id: uid(a), eligible_as: 'reserve_next' },
        { user_id: uid(b), eligible_as: 'reserve_next' },
      ].sort((x, y) => x.user_id.localeCompare(y.user_id)),
    );
    expect((await accept(a, k14)).result).toBe('assigned_waiting');
    await tick(5);
    await customerAsks(k16);
    round = (await roundOf(k16.taskId!))!;
    expect(round.recipients.find((r) => r.user_id === uid(a))!.eligible_as).toBe('view_only');
    expect((await accept(b, k16)).result).toBe('assigned_waiting');
    // nobody can act any more: the next requests open view-only broadcasts (10 §4.8)
    await staffAsks(k11);
    ok(
      await cmd('SUP-R', 'post', `/v1/tickets/${k5.ticketId}/payment-waiver`, {
        reason: 'ضيف كبار الزوار على حساب المضيف',
      }),
    );
    await tick(5);
    await staffAsks(k5);
    for (const car of [k11, k5]) {
      const r = (await roundOf(car.taskId!))!;
      expect(r.mode).toBe('broadcast');
      expect(new Set(r.recipients.map((x) => x.eligible_as))).toEqual(new Set(['view_only']));
    }
    // the late driver arrives: the oldest becomes his single offer, the newer broadcast is extended to him
    const extendedBefore = await rows(
      w.db,
      `SELECT id FROM outbox_events WHERE type = 'task.broadcast_extended'`,
    );
    await startDuty('DRV5');
    expect(await singleOfferTo(k11)).toBe('DRV5');
    const ext = await rows(
      w.db,
      `SELECT payload->'payload' AS p FROM outbox_events WHERE type = 'task.broadcast_extended' ORDER BY seq`,
    );
    expect(ext.length).toBe(extendedBefore.length + 1);
    expect(ext.at(-1)!.p).toMatchObject({
      task_id: k5.taskId,
      added: [{ user_id: U.DRV5, eligible_as: 'accept' }],
    });
    await accept('DRV5', k11);

    // the three drivers bring their cars while the provider is down
    await bring(a, k10);
    await bring(b, k12);
    await bring('DRV5', k11);
    expect((await messagesTo(w, k10.phone!)).map((m) => m.purpose)).toEqual(['W-01', 'W-02']);
    // a separate collection before the handover (07 §9.4), then the stub alone
    const paid = ok(await cmd('DRV5', 'post', `/v1/tickets/${k11.ticketId}/payments`, CASH), 201);
    expect(paid.payment).toMatchObject({ method: 'cash', status: 'recorded' });
    await handOver('DRV5', k11);

    // the provider is back: only the current state is sent (W-05 with the code, not the late W-03/W-04)
    await w.sim.client.setChannel({ state: 'up' });
    for (let i = 0; i < 60 && (await health()) !== 'healthy'; i++) await tick(10);
    expect(await health()).toBe('healthy');
    await tick(30);
    expect(
      (await rows(w.db, `SELECT status FROM alerts WHERE type = 'wa_channel_down' ORDER BY venue_id`)).every(
        (x) => x.status === 'resolved',
      ),
    ).toBe(true);
    const sent10 = (await messagesTo(w, k10.phone!)).map((m) => m.purpose);
    expect(sent10).toContain('W-05');
    expect(sent10).not.toContain('W-04');

    // a hands K10 over: his reserved K14 is promoted in the same transaction (task.promoted)
    await handOver(a, k10, CASH);
    expect((await one(w.db, `SELECT status FROM tasks WHERE id = $1`, [k14.taskId])).status).toBe('accepted');
    await handOver(b, k12, POS('AP1212'));
    expect((await one(w.db, `SELECT status FROM tasks WHERE id = $1`, [k16.taskId])).status).toBe('accepted');

    // K14: the guest reads the wrong message five times: the code locks, the supervisor hands over by exception
    await bring(a, k14);
    const real = await codeOf(k14);
    const wrong = real === '135791' ? '246802' : '135791';
    for (let left = 4; left >= 1; left--) {
      const e = err(
        await cmd(a, 'post', `/v1/tickets/${k14.ticketId}/handover`, {
          verification: { method: 'code', code: wrong },
          payment: CASH,
        }),
        'HANDOVER_CODE_INVALID',
        422,
      );
      expect(e.attempts_left).toBe(left);
    }
    err(
      await cmd(a, 'post', `/v1/tickets/${k14.ticketId}/handover`, {
        verification: { method: 'code', code: wrong },
        payment: CASH,
      }),
      'HANDOVER_CODE_LOCKED',
      423,
    );
    await pump();
    const lock = await one(
      w.db,
      `SELECT id, status FROM alerts WHERE type = 'handover_code_locked' AND ticket_id = $1`,
      [k14.ticketId],
    );
    expect(lock.status).toBe('open');
    const ex = ok(
      await cmd('SUP-R', 'post', `/v1/tickets/${k14.ticketId}/handover-exception`, {
        reason: 'العميل أدخل رمزًا من رسالة قديمة؛ تحقق بالهوية',
        identity_checks: { phone_last4: '0008', plate_confirmed: true },
        payment: { ...CASH, collected_by: uid(a) },
      }),
    );
    expect(ex.ticket.status).toBe('delivered');
    expect(ex.payment).toMatchObject({ method: 'cash', collected_by: { id: uid(a) } });
    expect((await one(w.db, `SELECT status FROM alerts WHERE id = $1`, [lock.id])).status).toBe('resolved');
    await pump();

    await bring(b, k16);
    await handOver(b, k16, POS('AP1616'));
    const c16 = (await messagesTo(w, k16.phone!)).map((m) => m.purpose);
    expect(c16.at(-1)).toBe('W-06');
    expect(c16).toContain('W-05');

    // K5 (waived) waited through the peak: the engine offers it to whoever is free first
    const r5 = (await roundOf(k5.taskId!))!;
    const d5 = nameOf(
      (r5.mode === 'single' ? r5.recipients[0] : r5.recipients.find((x) => x.eligible_as === 'accept'))!
        .user_id,
    );
    await accept(d5, k5);
    await bring(d5, k5);
    await handOver(d5, k5); // waived: nothing to collect
  });

  it('a transfer to «قاعة ليلتي»: refused while he holds a car, scheduled and blocked, completed once the car is parked; he works in LYL (AC-10, AC-16)', async () => {
    // the drivers come back from the prayer; DRV3 takes a late guest's car in (he holds it until it is parked)
    for (const d of ['DRV4', 'DRV6', 'DRV3']) {
      await brk(d, false);
      await tick(5);
    }
    const k17 = await intake('K17', 'DRV3', { channel: 'whatsapp', phone: '+966512340017' });

    const body = { to_venue_id: LYL, reason: 'دعم قاعة ليلتي في ذروة حفلها' };
    expect(
      err(await cmd('SUP-R', 'post', `/v1/drivers/${U.DRV3}/transfers`, body), 'TRANSFER_SCOPE_DENIED', 403),
    ).toMatchObject({ missing_venue_id: LYL });
    const blocked = err(
      await cmd('SUP-RL', 'post', `/v1/drivers/${U.DRV3}/transfers`, body),
      'TRANSFER_BLOCKED_CUSTODY',
      409,
    );
    expect(blocked.items.map((i: { type: string }) => i.type)).toContain('vehicle');
    expect(await rows(w.db, `SELECT id FROM driver_transfers WHERE driver_id = $1`, [U.DRV3])).toEqual([]);
    expect(await rows(w.db, `SELECT id FROM alerts WHERE type = 'transfer_blocked'`)).toEqual([]);

    const scheduled = ok(
      await cmd('SUP-RL', 'post', `/v1/drivers/${U.DRV3}/transfers`, {
        ...body,
        scheduled_at: new Date(w.clock.now().getTime() + 60_000).toISOString(),
      }),
      201,
    );
    expect(scheduled.status).toBe('pending');
    await tick(65);
    expect(
      (await one(w.db, `SELECT status FROM driver_transfers WHERE id = $1`, [scheduled.id])).status,
    ).toBe('blocked');
    expect(
      (await rows(w.db, `SELECT venue_id FROM alerts WHERE type = 'transfer_blocked' AND status = 'open'`))
        .map((x) => x.venue_id)
        .sort(),
    ).toEqual([RMS, LYL].sort());

    // the car is parked: the transfer watch activates it again and it completes
    await park('DRV3', k17);
    await tick(5);
    expect(
      await one(w.db, `SELECT status, from_venue_id FROM driver_transfers WHERE id = $1`, [scheduled.id]),
    ).toEqual({ status: 'completed', from_venue_id: RMS });
    expect(
      (await rows(w.db, `SELECT status FROM alerts WHERE type = 'transfer_blocked'`)).every(
        (x) => x.status === 'resolved',
      ),
    ).toBe(true);
    onDuty.delete('DRV3');
    expect(
      await rows(
        w.db,
        `SELECT venue_id, status FROM driver_assignments WHERE driver_id = $1 ORDER BY created_at`,
        [U.DRV3],
      ),
    ).toEqual([
      { venue_id: RMS, status: 'ended' },
      { venue_id: LYL, status: 'active' },
    ]);
    expect((await get('DRV3', '/v1/me')).body.error.code).toBe('AUTH_SESSION_REVOKED');
    // a stale notification of an RMS offer is not his any more (TC-051)
    await relogin('DRV3');
    const rmsOffer = await one<{ id: string }>(
      w.db,
      `SELECT o.id FROM task_offers o LEFT JOIN offer_recipients r ON r.offer_id = o.id AND r.user_id = $2
        WHERE o.dispatch_pool_id = $1 ORDER BY (r.user_id IS NULL), o.created_at DESC LIMIT 1`,
      [POOL_R, U.DRV3],
    );
    err(await cmd('DRV3', 'post', `/v1/task-offers/${rmsOffer.id}/accept`, {}), 'OFFER_NOT_FOUND', 404);
    // his RMS history keeps its venue and actor
    expect(
      await one(w.db, `SELECT venue_id, created_by, parked_by FROM tickets WHERE id = $1`, [k17.ticketId]),
    ).toEqual({ venue_id: RMS, created_by: U.DRV3, parked_by: U.DRV3 });

    // in LYL: on duty, takes a paper car in, the LYL supervisor asks for it, he brings and hands it over
    await startDuty('DRV3');
    const lyl = await intake('L1', 'DRV3', { channel: 'paper', event: SEED_IDS.events['EVT-L1'] });
    await tick(60);
    ok(
      await cmd('DRV3', 'post', `/v1/tasks/${lyl.parkTaskId}/complete-parking`, {
        parking_spot_id: seedSpotId('P1-01'),
        key_slot_id: seedKeySlotId('LYL', 1),
      }),
    );
    lyl.slotId = seedKeySlotId('LYL', 1);
    await tick(120, 10);
    await staffAsks(lyl, 'SUP-RL');
    expect(await singleOfferTo(lyl)).toBe('DRV3');
    await accept('DRV3', lyl);
    await bring('DRV3', lyl);
    await handOver('DRV3', lyl); // EVT-L1 is included: nothing to collect
    ok(await cmd('DRV3', 'post', '/v1/me/duty/end', {}));
    onDuty.delete('DRV3');
  });

  it('a reassignment to the driving supervisor and a withdrawal back to the queue (K9, K13)', async () => {
    await brk('SUP-RD', false); // back last: he is the least idle, the requests go to the others first
    const k9 = cars.get('K9')!;
    await staffAsks(k9);
    const x = await singleOfferTo(k9);
    expect(x).not.toBe('SUP-RD');
    await accept(x, k9);
    // the driver is at the far gate: the supervisor gives the car to SUP-RD, who drives tonight
    const re = ok(
      await cmd('SUP-R', 'post', `/v1/tasks/${k9.taskId}/reassign`, {
        reason: 'السائق بعيد عند البوابة الخلفية',
        target_driver_id: U['SUP-RD'],
      }),
    );
    expect(re.task).toMatchObject({ status: 'accepted', assignee: { id: U['SUP-RD'] } });
    await pump();
    await bring('SUP-RD', k9);
    const done9 = await handOver('SUP-RD', k9, CASH);
    expect(done9.payment.collected_by).toMatchObject({ id: U['SUP-RD'] });

    const k13 = cars.get('K13')!;
    await tick(30);
    await staffAsks(k13);
    const y = await singleOfferTo(k13);
    await accept(y, k13);
    const back = ok(
      await cmd('SUP-R', 'post', `/v1/tasks/${k13.taskId}/reassign`, {
        reason: 'السائق انشغل بطارئ',
        target_driver_id: null,
      }),
    );
    expect(back.ticket.status).toBe('requested');
    await pump();
    const z = await singleOfferTo(k13);
    expect(z).not.toBe(y);
    await accept(z, k13);
    await bring(z, k13);
    await handOver(z, k13, CASH);
  });

  it('a driver loses the network with a car (connection alert), then a POS payment that failed is reversed, the incident followed up and the fee waived (K2)', async () => {
    const k2 = cars.get('K2')!;
    await tick(20);
    await staffAsks(k2);
    const e = await singleOfferTo(k2);
    await accept(e, k2);
    await tick(30);
    ok(await cmd(e, 'post', `/v1/tasks/${k2.taskId}/key-pickup`, { key_slot_id: k2.slotId }));
    await tick(15);
    ok(await cmd(e, 'post', `/v1/tasks/${k2.taskId}/start-retrieval`, {}));
    const session = (
      await one(w.db, `SELECT id FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`, [uid(e)])
    ).id as string;
    const changes = async () =>
      (
        await rows(
          w.db,
          `SELECT payload->'payload'->>'to' AS "to" FROM outbox_events
            WHERE type = 'driver.connection_changed' AND aggregate_id = $1 ORDER BY seq`,
          [session],
        )
      ).map((c) => c.to as string);
    // the heartbeats of every phone kept every driver online so far
    expect(await changes()).toEqual([]);
    // the basement has no signal: no heartbeat for two minutes (uncertain after 45 s, offline after 120 s)
    silent.add(e);
    await tick(130, 5);
    expect(await changes()).toEqual(['uncertain', 'offline']);
    const lost = await one(
      w.db,
      `SELECT id, status FROM alerts WHERE type = 'driver_connection_lost_with_custody' AND dedupe_key = $1`,
      [`driver_connection_lost_with_custody:${session}`],
    );
    expect(lost.status).toBe('open');
    silent.delete(e);
    await heartbeats(true);
    await tick(20);
    expect(await changes()).toEqual(['uncertain', 'offline', 'online']);
    expect((await one(w.db, `SELECT status FROM alerts WHERE id = $1`, [lost.id])).status).toBe('resolved');
    ok(await cmd(e, 'post', `/v1/tasks/${k2.taskId}/ready`, {}));
    await pump();
    const done = await handOver(e, k2, POS('AP2002'));

    // the terminal's batch shows the transaction failed: reversed without replacement → due + incident
    await tick(300, 30);
    ok(
      await cmd('SUP-R', 'post', `/v1/payments/${done.payment.id}/reverse`, {
        reason: 'عملية الشبكة لم تكتمل في تقرير الجهاز',
      }),
    );
    expect(
      (await one(w.db, `SELECT payment_status FROM tickets WHERE id = $1`, [k2.ticketId])).payment_status,
    ).toBe('due');
    const incident = await one(
      w.db,
      `SELECT id, status, version FROM incidents WHERE type = 'payment_discrepancy' AND ticket_id = $1`,
      [k2.ticketId],
    );
    expect(incident.status).toBe('open');
    ok(
      await cmd('SUP-R', 'patch', `/v1/incidents/${incident.id}`, {
        expected_version: incident.version,
        status: 'in_review',
        owner_id: U['SUP-R'],
      }),
    );
    // the host covers the guest's fee: waived, then the incident is resolved with the decision
    ok(
      await cmd('SUP-R', 'post', `/v1/tickets/${k2.ticketId}/payment-waiver`, {
        reason: 'المضيف تحمّل رسوم التذكرة بعد فشل عملية الشبكة',
      }),
    );
    ok(
      await cmd('SUP-R', 'patch', `/v1/incidents/${incident.id}`, {
        expected_version: incident.version + 1,
        status: 'resolved',
        resolution: 'أُعفيت التذكرة بموافقة المضيف',
      }),
    );
    await pump();
  });

  it('ten minutes without the API: the venue works on the paper log, then the supervisor reconciles the car (TC-038, K15); a driver disabled and enabled again', async () => {
    const k15 = cars.get('K15')!;
    await staffAsks(k15);
    const r = await singleOfferTo(k15);
    await accept(r, k15);
    // the API is unreachable for ten minutes: no request at all (the PWAs cannot reach it); the worker goes on.
    // On paper: r takes the key, brings the car and hands it over against the stub, the cash is collected.
    const all = [...onDuty];
    for (const d of all) silent.add(d);
    await tick(600, 30);
    for (const d of all) silent.delete(d);
    await heartbeats(true);
    await pump();
    const reconciled = ok(
      await cmd('SUP-R', 'post', `/v1/tickets/${k15.ticketId}/manual-reconcile`, {
        target_status: 'delivered',
        reason: 'سُلّمت أثناء انقطاع النظام وفق السجل الورقي',
        evidence: { paper_log_ref: 'PL-15', note: 'كعب ورقي مطابق وتوقيع العميل' },
        payment: { ...CASH, collected_by: uid(r) },
      }),
    );
    expect(reconciled).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    expect(
      await rows(
        w.db,
        `SELECT DISTINCT reason FROM custody_events WHERE ticket_id = $1 AND reason = 'manual_reconcile'`,
        [k15.ticketId],
      ),
    ).toEqual([{ reason: 'manual_reconcile' }]);
    expect(
      (
        await one(w.db, `SELECT collected_by FROM payments WHERE ticket_id = $1 AND status = 'recorded'`, [
          k15.ticketId,
        ])
      ).collected_by,
    ).toBe(uid(r));
    await tick(30);

    // DRV6 reports his phone lost: the administrator disables the account (duty ended, sessions revoked) and
    // enables it again once he has a new phone; he signs in and goes back on duty
    const idle = await one(w.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [U.DRV6]);
    expect(idle.driver_state).toBe('available');
    ok(await cmd('ADM1', 'post', `/v1/drivers/${U.DRV6}/disable`, { reason: 'أبلغ عن فقد جواله' }));
    onDuty.delete('DRV6');
    expect((await get('DRV6', '/v1/me')).body.error.code).toBe('AUTH_SESSION_REVOKED');
    expect(
      (
        await one(
          w.db,
          `SELECT end_reason FROM duty_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [U.DRV6],
        )
      ).end_reason,
    ).toBe('disabled');
    ok(await cmd('ADM1', 'post', `/v1/drivers/${U.DRV6}/enable`, {}));
    await relogin('DRV6');
    await startDuty('DRV6');
    await pump();
  });

  it('closing: start-closing stops the intake, the reconciliation lists what is open, the last car and the cash are handed over, the event closes and the shift closes', async () => {
    ok(await cmd('SUP-R', 'post', `/v1/events/${eventId}/start-closing`, {}));
    err(
      await cmd('DRV1', 'post', '/v1/tickets', { event_id: eventId, channel: 'paper' }),
      'EVENT_NOT_OPEN',
      409,
    );
    const k17 = cars.get('K17')!;
    let rec = ok(await get('SUP-R', `/v1/events/${eventId}/reconciliation`));
    expect(rec.can_close).toBe(false);
    expect(rec.blockers.open_tickets.map((x: { id: string }) => x.id)).toEqual([k17.ticketId]);
    expect(rec.blockers.unsettled_payments).toEqual([]);
    expect(rec.blockers.cash_outstanding.length).toBeGreaterThan(0);
    const blocked = err(
      await cmd('SUP-R', 'post', `/v1/events/${eventId}/close`, {}),
      'EVENT_CLOSE_BLOCKED',
      409,
    );
    expect(blocked).toEqual({ blockers: rec.blockers });

    // the last guest leaves during the closing (retrievals and money go on, 13 §12)
    await customerAsks(k17);
    const d = await singleOfferTo(k17);
    await accept(d, k17);
    await bring(d, k17);
    await handOver(d, k17, CASH);

    // the cash: every driver hands over what he holds; DRV2 is five riyals short (a recorded difference)
    const s = ok(await get('SUP-R', `/v1/events/${eventId}/settlement`));
    const owing = s.drivers.filter(
      (x: { cash: { outstanding_halalas: number } }) => x.cash.outstanding_halalas > 0,
    ) as { driver: { id: string }; cash: { outstanding_halalas: number } }[];
    expect(owing.map((x) => x.driver.id)).toContain(U.DRV2);
    for (const o of owing) {
      const short = o.driver.id === U.DRV2 ? 500 : 0;
      const h = ok(
        await cmd('SUP-R', 'post', '/v1/cash-handovers', {
          event_id: eventId,
          driver_id: o.driver.id,
          amount_halalas: o.cash.outstanding_halalas - short,
          ...(short ? { note: 'نقص خمسة ريالات عند العد' } : {}),
        }),
        201,
      );
      expect(h.difference_halalas).toBe(short ? -short : 0);
      expect(h.incident_id === null).toBe(short === 0);
    }
    await pump();

    rec = ok(await get('SUP-R', `/v1/events/${eventId}/reconciliation`));
    expect(rec.can_close).toBe(true);
    expect(Object.values(rec.blockers).every((l) => (l as unknown[]).length === 0)).toBe(true);
    expect(rec.warnings.cash_discrepancies.length).toBe(1); // warnings never block

    await tick(60, 30);
    const before = await one(w.db, `SELECT version FROM events WHERE id = $1`, [eventId]);
    const closed = ok(
      await cmd('SUP-R', 'post', `/v1/events/${eventId}/close`, {
        expected_version: before.version,
        note: 'انتهى الحفل؛ نقص نقدي موثق بواقعة',
      }),
    );
    expect(closed.status).toBe('closed');
    err(await cmd('SUP-R', 'post', `/v1/events/${eventId}/close`, {}), 'EVENT_ALREADY_CLOSED', 409);

    // the shift closes: every remaining duty ends (shift_closed)
    const shift = ok(await cmd('SUP-R', 'post', `/v1/shifts/${shiftId}/close`, {}));
    expect(shift.status).toBe('closed');
    for (const x of [...onDuty]) onDuty.delete(x);
    expect(
      await rows(w.db, `SELECT id FROM duty_sessions WHERE dispatch_pool_id = $1 AND status <> 'ended'`, [
        POOL_R,
      ]),
    ).toEqual([]);
    await pump();
  });

  // ============================================================================================== acceptance
  it('PNT-093 AC: no open custody, the amounts match, the event is closed, the transfer succeeded, the invariants hold', async () => {
    // the event is closed with its summary
    const ev = await one(w.db, `SELECT status, closed_by, close_summary FROM events WHERE id = $1`, [
      eventId,
    ]);
    expect(ev).toMatchObject({ status: 'closed', closed_by: U['SUP-R'] });

    // no open custody: every car back with its customer (or never taken: the voided draft went back to him)
    const tickets = await rows(
      w.db,
      `SELECT status, vehicle_holder_type, key_holder_type FROM tickets WHERE event_id = $1`,
      [eventId],
    );
    expect(tickets.length).toBe(17);
    expect(tickets.filter((x) => x.status === 'delivered').length).toBe(16);
    expect(tickets.filter((x) => x.status === 'voided').length).toBe(1);
    expect(
      tickets.every((x) => x.vehicle_holder_type === 'customer' && x.key_holder_type === 'customer'),
    ).toBe(true);
    for (const sql of [
      `SELECT a.id FROM spot_allocations a JOIN tickets t ON t.id = a.ticket_id WHERE t.event_id = $1 AND a.released_at IS NULL`,
      `SELECT a.id FROM key_slot_allocations a JOIN tickets t ON t.id = a.ticket_id WHERE t.event_id = $1 AND a.released_at IS NULL`,
      `SELECT id FROM tasks WHERE event_id = $1 AND status NOT IN ('completed','canceled')`,
      `SELECT o.id FROM task_offers o JOIN tasks k ON k.id = o.task_id WHERE k.event_id = $1 AND o.status = 'active'`,
      `SELECT c.id FROM claim_codes c JOIN tickets t ON t.id = c.ticket_id
        WHERE t.event_id = $1 AND c.consumed_at IS NULL AND c.revoked_at IS NULL`,
      `SELECT c.id FROM claim_codes c JOIN tickets t ON t.id = c.ticket_id WHERE t.event_id = $1 AND c.code_ciphertext IS NOT NULL`,
      `SELECT rc.id FROM retrieval_cycles rc JOIN tickets t ON t.id = rc.ticket_id WHERE t.event_id = $1 AND rc.closed_at IS NULL`,
    ])
      expect(await rows(w.db, sql, [eventId]), sql).toEqual([]);

    // the amounts match: the settlement equals the recorded payments; the cash handed over equals the cash
    // collected plus the recorded differences; nothing outstanding, nothing due
    const s = ok(await get('SUP-R', `/v1/events/${eventId}/settlement`));
    const money = await one(
      w.db,
      `SELECT coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded'), 0)::int AS recorded,
              coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'cash'), 0)::int AS cash,
              coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'pos'), 0)::int AS pos,
              count(*) FILTER (WHERE status = 'reversed')::int AS reversed
         FROM payments WHERE event_id = $1`,
      [eventId],
    );
    const handed = await one(
      w.db,
      `SELECT coalesce(sum(amount_halalas), 0)::int AS amount, coalesce(sum(expected_halalas), 0)::int AS expected,
              coalesce(sum(difference_halalas), 0)::int AS difference, count(*)::int AS n
         FROM cash_handovers WHERE event_id = $1`,
      [eventId],
    );
    expect(s.amounts.collected_halalas).toBe(money.recorded);
    expect(handed.expected).toBe(money.cash);
    expect(handed.amount).toBe(money.cash + handed.difference);
    expect(handed.difference).toBe(-500);
    expect(money.reversed).toBe(2);
    expect(s.amounts.billable_halalas).toBe(
      s.amounts.collected_halalas + s.amounts.waived_halalas + s.amounts.due_halalas,
    );
    expect(s.amounts.due_halalas).toBe(0);
    expect(s.integrity.ok).toBe(true);
    expect(
      s.drivers.every((d: { cash: { outstanding_halalas: number } }) => d.cash.outstanding_halalas === 0),
    ).toBe(true);
    expect(
      await rows(
        w.db,
        `SELECT id FROM payments WHERE event_id = $1 AND method = 'cash' AND status = 'recorded' AND cash_handover_id IS NULL`,
        [eventId],
      ),
    ).toEqual([]);
    expect(ev.close_summary.finance).toEqual({
      currency: 'SAR',
      amounts: s.amounts,
      drivers: s.drivers,
      discrepancies: s.discrepancies,
    });
    expect(ev.close_summary.tickets).toEqual(s.tickets);
    const diffIncident = await rows(
      w.db,
      `SELECT id FROM incidents WHERE type = 'payment_discrepancy' AND event_id = $1 AND ticket_id IS NULL`,
      [eventId],
    );
    expect(diffIncident.length).toBe(1);
    expect(ev.close_summary.warnings.cash_discrepancies.length).toBe(1);

    // the transfer scenario: completed, the driver now in LYL, his RMS work kept with its venue and actor
    expect(
      await rows(
        w.db,
        `SELECT status, from_venue_id, to_venue_id FROM driver_transfers WHERE driver_id = $1`,
        [U.DRV3],
      ),
    ).toEqual([{ status: 'completed', from_venue_id: RMS, to_venue_id: LYL }]);
    expect(
      (
        await one(w.db, `SELECT count(*)::int AS n FROM tickets WHERE event_id = $1 AND created_by = $2`, [
          eventId,
          U.DRV3,
        ])
      ).n,
    ).toBeGreaterThan(0);

    // every command left its audit row; nothing is left for the worker (no dead, no failed row)
    expect(
      await rows(w.db, `SELECT type, status FROM outbox_events WHERE status IN ('failed','dead')`),
    ).toEqual([]);

    // the invariants: the 10 §14.1 / 11 §1.7 queries, the consistency queries of the restore drill, and
    // docs/06_schema_invariants_test.sql on a fresh database built from the same migrations
    await expectConsistent(w.db);
    const consistency = readFileSync(
      join(import.meta.dirname, '../../../infra/backup/consistency.sql'),
      'utf8',
    );
    const checks = await rows<{ check_name: string; violations: string }>(w.db, consistency);
    expect(checks.length).toBeGreaterThan(5);
    expect(checks.filter((c) => Number(c.violations) !== 0)).toEqual([]);
    const inv = await runInvariants(process.env.TEST_DATABASE_URL!);
    expect(inv.passed).toBe(true);
  });

  // ============================================================================================== PNT-090 AC2
  it('PNT-090 AC2: every domain event of the run — all 71 canon §7.1 types — has exactly one analytics row, inside the allow-list', async () => {
    await pump();
    const events = await rows<{ id: string; type: string; status: string }>(
      w.db,
      `SELECT id, type, status FROM outbox_events WHERE type = ANY($1::text[]) ORDER BY seq`,
      [[...DOMAIN_EVENT_TYPES]],
    );
    expect(events.filter((e) => e.status !== 'done')).toEqual([]);
    const analytics = await rows<{
      name: string;
      source_event_id: string;
      properties: Record<string, unknown>;
      actor_role: string;
      text: string;
    }>(
      w.db,
      `SELECT name, properties->>'source_event_id' AS source_event_id, properties, actor_role, a::text AS text
         FROM analytics_events a WHERE source = 'server'`,
    );
    // exactly once: one row per committed domain event, named after its type (15 §4), none without its event
    const byEvent = new Map<string, number>();
    for (const a of analytics) byEvent.set(a.source_event_id, (byEvent.get(a.source_event_id) ?? 0) + 1);
    const typeOf = new Map(events.map((e) => [e.id, e.type]));
    expect([...byEvent.values()].every((n) => n === 1)).toBe(true);
    expect(analytics.length).toBe(events.length);
    for (const a of analytics)
      expect(a.name).toBe(analyticsName(typeOf.get(a.source_event_id) as DomainEventType));
    // every tracked server action of 15 §7 happened in this run
    const seen = new Set(events.map((e) => e.type));
    expect(DOMAIN_EVENT_TYPES.filter((t) => !seen.has(t))).toEqual([]);
    expect(new Set(analytics.map((a) => a.name))).toEqual(new Set(DOMAIN_EVENT_TYPES.map(analyticsName)));

    // the allow-list (15 §3, §7): only the catalog's keys, no denylisted key, no phone, plate, code or key position
    const denied = new Set<string>(ANALYTICS_PII_DENYLIST);
    for (const a of analytics) {
      const type = typeOf.get(a.source_event_id) as DomainEventType;
      const allowed = new Set([...Object.keys(SERVER_ANALYTICS_PROPERTIES[type]), 'source_event_id']);
      const keys = Object.keys(a.properties);
      expect(
        keys.filter((k) => !allowed.has(k)),
        `${a.name}`,
      ).toEqual([]);
      expect(
        keys.filter((k) => denied.has(k)),
        `${a.name}`,
      ).toEqual([]);
      expect(findPiiValues(a.properties), `${a.name}`).toEqual([]);
      expect(['owner', 'admin', 'supervisor', 'driver', 'customer', 'system']).toContain(a.actor_role);
    }
    const all = analytics.map((a) => a.text).join('\n');
    const props = analytics.map((a) => JSON.stringify(a.properties)).join('\n');
    const secrets: string[] = [];
    for (const p of phones) secrets.push(p, p.replace('+966', '0'), p.replace('+', ''));
    for (const code of codesSeen) secrets.push(code);
    for (const car of cars.values()) {
      if (car.slotId) secrets.push(car.slotId);
      if (car.spotId) secrets.push(car.spotId);
      if (car.serial) secrets.push(car.serial);
      secrets.push(`KT-${car.plateDigits}`);
      expect(props.includes(`"${car.plateDigits}"`), `plate ${car.plateDigits}`).toBe(false);
    }
    expect(codesSeen.size).toBeGreaterThan(5);
    expect(secrets.filter((x) => all.includes(x))).toEqual([]);
    expect(/[؀-ۿ]/.test(props)).toBe(false);
    // nothing was refused by the allow-list and no value fell outside its list (stored as null) during the run
    expect(await serverRejections()).toEqual(rejectedBefore);
  });
});
