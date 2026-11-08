import {
  OutboxDispatcher,
  RetryableJobError,
  dispatchJobs,
  notificationsJobs,
  ticketsCustodyJobs,
  whatsappJobs,
  type JobHandler,
} from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCustomerApp,
  cyclesOf,
  freshDriver,
  messagesTo,
  park,
  press,
  settle,
  tasksOf,
  ticketRow,
  whatsappTicket,
  type CustomerApp,
} from './customer-harness.js';
import { expectConsistent } from './dispatch-fixtures.js';
import { silentLogger } from './wa-harness.js';

const INBOUND = 'job.wa_process_inbound';

/**
 * 17 TC-003 (AC-01): ten button messages processed by two workers in parallel, one processing failing on purpose and
 * then retried. wa-button.int.test.ts proves TC-001 and TC-002 with the single harness dispatcher; here two
 * OutboxDispatchers lease the same queue (FOR UPDATE SKIP LOCKED) with five jobs each running concurrently, one job
 * fails before its work and another after its work committed (a crash before the outbox row is marked done), and both
 * are retried after their delay. Expected (17): one cycle, no deadlock, every `whatsapp_inbound_events` row
 * `processed`, the invariants green.
 */
describe('AC-01 / TC-003 — duplicate presses on two parallel workers with an injected failure and its retry', () => {
  let w: CustomerApp;
  beforeAll(async () => {
    w = await createCustomerApp();
  });
  afterAll(async () => w?.close());

  it('one cycle and one W-02; no deadlock or lock timeout; all ten inbound events processed after the retries', async () => {
    // a linked WhatsApp ticket, parked by its driver
    const driver = await freshDriver(w);
    const phone = '+966557731003';
    const t = await whatsappTicket(w, driver, phone);
    expect(t.submit!.status).toBe(200);
    await settle(w, phone);
    const w01 = (await messagesTo(w, phone)).filter((m) => m.purpose === 'W-01').at(-1)!;
    await park(w, driver, t.taskId);
    expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('linked');
    await w.drain();
    expect(
      (
        await w.db.query(
          `SELECT count(*)::int AS n FROM outbox_events WHERE status = 'pending' AND available_at <= $1`,
          [w.clock.now()],
        )
      ).rows[0].n,
    ).toBe(0);

    // ten real taps (ten wamids), delivered five at a time; the webhook only stores and enqueues
    const res = await press(w, phone, {
      wamid: w01.wamid,
      copies: 10,
      parallel: 5,
      duplicateMode: 'distinct',
    });
    expect(res.deliveries.every((d) => d.httpStatus === 200)).toBe(true);
    const jobs = (
      await w.db.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE type = $1 AND status = 'pending' ORDER BY seq`,
        [INBOUND],
      )
    ).rows.map((r) => r.id);
    expect(jobs).toHaveLength(10);
    const failBefore = jobs[0]!; // a transient failure before any work (e.g. a dropped connection)
    const failAfter = jobs[9]!; // the work committed, then the worker failed before marking the row done

    // two workers with the real handlers; the inbound handler carries the injected failures (once per job)
    const injected: string[] = [];
    const processedBy = new Map<string, Set<string>>();
    const inboundOutcomes: { worker: string; id: string; outcome: string }[] = [];
    const worker = (name: string) => {
      const d = new OutboxDispatcher(
        w.db,
        w.clock,
        silentLogger,
        { workerId: name, batchSize: 5, concurrency: 5 },
        {
          onOutcome: (row, outcome) => {
            if (row.type === INBOUND) inboundOutcomes.push({ worker: name, id: row.id, outcome });
          },
        },
      );
      const wrap = (h: JobHandler): JobHandler =>
        h.type !== INBOUND
          ? h
          : {
              ...h,
              async handle(ctx) {
                if (!processedBy.has(name)) processedBy.set(name, new Set());
                processedBy.get(name)!.add(ctx.row.id);
                if (ctx.row.id === failBefore && !injected.includes('before')) {
                  injected.push('before');
                  throw new RetryableJobError('TC-003 injected failure before processing', 1000);
                }
                await h.handle(ctx);
                if (ctx.row.id === failAfter && !injected.includes('after')) {
                  injected.push('after');
                  throw new RetryableJobError('TC-003 injected failure after processing', 1000);
                }
              },
            };
      for (const h of [
        ...whatsappJobs({ runtime: w.rt }),
        ...notificationsJobs(),
        ...dispatchJobs(),
        ...ticketsCustodyJobs(),
      ])
        d.register(wrap(h));
      return d;
    };
    const a = worker('tc003-worker-a');
    const b = worker('tc003-worker-b');

    // first round: each worker leases five of the ten jobs (SKIP LOCKED) and runs them concurrently
    const [na, nb] = await Promise.all([a.tick(), b.tick()]);
    expect([na, nb]).toEqual([5, 5]);
    expect(processedBy.get('tc003-worker-a')?.size).toBe(5);
    expect(processedBy.get('tc003-worker-b')?.size).toBe(5);
    expect(injected.sort()).toEqual(['after', 'before']);
    // the two failed jobs wait for their retry delay; then both workers drain in parallel again
    w.clock.advanceSeconds(2);
    await Promise.all([a.drain(200), b.drain(200)]);
    await settle(w, phone);

    // every inbound job ended done; the only retries are the two injected ones (no deadlock, no lock timeout)
    const rows = (
      await w.db.query<{ id: string; status: string; attempts: number }>(
        `SELECT id, status, attempts FROM outbox_events WHERE id = ANY($1::uuid[])`,
        [jobs],
      )
    ).rows;
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.attempts]))).toEqual(
      Object.fromEntries(jobs.map((id) => [id, id === failBefore || id === failAfter ? 2 : 1])),
    );
    const retries = inboundOutcomes.filter((o) => o.outcome !== 'done');
    expect(retries.map((o) => [o.id, o.outcome]).sort()).toEqual(
      [
        [failAfter, 'retry'],
        [failBefore, 'retry'],
      ].sort(),
    );

    // one request: one cycle, one retrieve task, one W-02; the ten presses stored once each, every event processed
    expect(await cyclesOf(w, t.ticketId)).toHaveLength(1);
    expect((await tasksOf(w, t.ticketId)).filter((k) => k.type === 'retrieve')).toHaveLength(1);
    const w02 = await w.db.query(
      `SELECT count(*)::int AS n FROM notifications WHERE ticket_id = $1 AND purpose = 'W-02'`,
      [t.ticketId],
    );
    expect(w02.rows[0].n).toBe(1);
    const stored = await w.db.query(
      `SELECT count(*)::int AS n FROM whatsapp_messages WHERE direction = 'inbound' AND wa_message_id = ANY($1::text[])`,
      [res.wamids],
    );
    expect(stored.rows[0].n).toBe(10);
    const events = (
      await w.db.query<{ status: string; raw_body: string }>(
        `SELECT status, raw_body FROM whatsapp_inbound_events`,
      )
    ).rows.filter((e) => res.wamids.some((id) => e.raw_body.includes(id)));
    expect(events).toHaveLength(10);
    expect(events.every((e) => e.status === 'processed')).toBe(true);
    await expectConsistent(w.db);
  });
});
