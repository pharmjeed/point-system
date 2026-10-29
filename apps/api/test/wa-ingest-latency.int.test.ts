import { metrics } from '@point/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCustomerApp,
  freshDriver,
  messagesTo,
  park,
  press,
  settle,
  whatsappTicket,
  type CustomerApp,
} from './customer-harness.js';
import { ok, outboxEvents, requestRetrieval } from './dispatch-fixtures.js';

/**
 * «حفظ الطلب» (15 §10 performance targets, 17 H-08 M1): from the webhook carrying the press to the committed
 * retrieval cycle. The `ticket.retrieval_requested` event of a press carries `ingest_latency_ms` (projected to
 * `ticket_retrieval_requested`, 15 §7) and the worker observes `point_retrieval_request_ingest_seconds`
 * (05 §12.2). Found missing by the automated rehearsal (PNT-102): both were declared and never filled.
 */

let phoneSeq = 4_700_000;
const newPhone = () => `+96655${phoneSeq++}`;

/** count and sum of the histogram (the api and the worker share the registry in tests) */
const ingestHistogram = async () => {
  const values = (await metrics.retrievalIngest.get()).values;
  const pick = (suffix: string) =>
    values.find(
      (v) => (v as { metricName?: string }).metricName === `point_retrieval_request_ingest_seconds${suffix}`,
    )?.value ?? 0;
  return { count: pick('_count'), sum: pick('_sum') };
};

describe('request save latency (15 §10 ingest_latency_ms, 05 §12.2 point_retrieval_request_ingest_seconds)', () => {
  let w: CustomerApp;
  beforeAll(async () => {
    w = await createCustomerApp();
  });
  afterAll(async () => w?.close());
  beforeEach(async () => {
    w.clock.advance(10 * 60_000);
    await w.drain();
  });

  async function linkedTicket(o: { parking?: boolean } = {}) {
    const driver = await freshDriver(w, 'RMS');
    const phone = newPhone();
    const t = await whatsappTicket(w, driver, phone);
    expect(t.submit!.status).toBe(200);
    await settle(w, phone);
    const w01 = (await messagesTo(w, phone)).filter((m) => m.purpose === 'W-01').at(-1)!;
    if (!o.parking) await park(w, driver, t.taskId, 'RMS');
    return { ...t, driver, w01 };
  }

  const requested = async (ticketId: string) =>
    (await outboxEvents(w.db, 'ticket.retrieval_requested'))
      .map((e) => e.payload.payload)
      .filter((p) => p.ticket.ticket_id === ticketId);

  it('a press that opens the cycle: the event carries webhook → commit, the worker observes the histogram', async () => {
    const t = await linkedTicket();
    const before = await ingestHistogram();
    await press(w, t.phone, { wamid: t.w01.wamid });
    w.clock.advance(1500); // the worker takes the stored delivery 1.5 s after the api received it
    await settle(w, t.phone);
    const events = await requested(t.ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ request_source: 'whatsapp', ingest_latency_ms: 1500 });
    // the same span in the rows: the stored delivery → the cycle's transaction
    const span = (
      await w.db.query(
        `SELECT (extract(epoch FROM c.created_at - e.received_at) * 1000)::int AS ms
           FROM retrieval_cycles c, whatsapp_inbound_events e
          WHERE c.id = $1 AND e.raw_body LIKE '%"button"%' AND e.received_at <= c.created_at
          ORDER BY e.received_at DESC LIMIT 1`,
        [events[0].cycle_id],
      )
    ).rows[0];
    expect(span.ms).toBe(1500);
    const after = await ingestHistogram();
    expect(after.count - before.count).toBe(1);
    expect(after.sum - before.sum).toBeCloseTo(1.5, 6);
  });

  it('a press while the car is being parked (converted later at parking) and a staff request carry none', async () => {
    const early = await linkedTicket({ parking: true });
    const before = await ingestHistogram();
    await press(w, early.phone, { wamid: early.w01.wamid });
    w.clock.advance(800);
    await settle(w, early.phone);
    await park(w, early.driver, early.taskId, 'RMS'); // TT-08: the cycle opens now, with the press time
    const converted = await requested(early.ticketId);
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({ requested_early: true });
    expect(converted[0]).not.toHaveProperty('ingest_latency_ms');

    const onBehalf = await linkedTicket();
    ok(await requestRetrieval(w, 'SUP-R', onBehalf.ticketId), 201);
    const staff = await requested(onBehalf.ticketId);
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ request_source: 'staff' });
    expect(staff[0]).not.toHaveProperty('ingest_latency_ms');
    expect((await ingestHistogram()).count).toBe(before.count);
  });
});
