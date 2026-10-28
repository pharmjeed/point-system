import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OutboxDispatcher,
  PermanentJobError,
  RetryableJobError,
  type JobHandler,
} from '../src/core/outbox/dispatcher.js';
import { enqueue, schedule } from '../src/core/outbox/outbox-writer.js';
import { ORG, insertOrgAndUser, setupDb, silentLogger, type TestContext } from './helpers.js';

// PNT-007 acceptance criteria.
describe('outbox dispatcher', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupDb();
    await insertOrgAndUser(t.db);
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.db.query(`DELETE FROM outbox_events`);
  });

  const counting = (type: string, seen: Map<string, number>, mode: 'tx' | 'external' = 'tx'): JobHandler => ({
    type,
    mode,
    async handle({ row }) {
      seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, Math.random() * 3));
    },
  });

  it('two parallel workers never process the same row twice (200 jobs)', async () => {
    await t.db.transaction(async (tx) => {
      for (let i = 0; i < 200; i++) await enqueue(tx, { type: 'job.test', orgId: ORG, payload: { i } });
    });
    const seen = new Map<string, number>();
    const a = new OutboxDispatcher(t.db, t.clock, silentLogger, {
      workerId: 'A',
      batchSize: 15,
      concurrency: 4,
    });
    const b = new OutboxDispatcher(t.db, t.clock, silentLogger, {
      workerId: 'B',
      batchSize: 15,
      concurrency: 4,
    });
    a.register(counting('job.test', seen));
    b.register(counting('job.test', seen));
    await Promise.all([a.drain(), b.drain()]);
    expect(seen.size).toBe(200);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const r = await t.db.query(`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'done'`);
    expect(r.rows[0].n).toBe(200);
  });

  it('a lease that expires after a worker crash is resumed by another worker', async () => {
    await t.db.transaction((tx) => enqueue(tx, { type: 'job.test', orgId: ORG }));
    const crashed = new OutboxDispatcher(t.db, t.clock, silentLogger, {
      workerId: 'crashed',
      leaseSeconds: 30,
    });
    const leased = await crashed.lease(); // leased, never completed
    expect(leased).toHaveLength(1);
    const seen = new Map<string, number>();
    const other = new OutboxDispatcher(t.db, t.clock, silentLogger, { workerId: 'other', leaseSeconds: 30 });
    other.register(counting('job.test', seen));
    expect(await other.tick()).toBe(0); // still leased
    t.clock.advanceSeconds(31);
    expect(await other.recoverExpiredLeases()).toBe(1);
    expect(await other.drain()).toBe(1);
    expect(seen.get(leased[0]!.id)).toBe(1);
    const row = (
      await t.db.query(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [leased[0]!.id])
    ).rows[0];
    expect(row).toEqual({ status: 'done', attempts: 2 });
  });

  it('rows with the same ordering_key keep their order even with retries', async () => {
    await t.db.transaction(async (tx) => {
      for (let i = 0; i < 5; i++)
        await enqueue(tx, { type: 'job.ordered', orgId: ORG, orderingKey: 'wa:T1', payload: { i } });
    });
    const order: number[] = [];
    let failedOnce = false;
    const d = new OutboxDispatcher(t.db, t.clock, silentLogger, {
      workerId: 'W',
      batchSize: 10,
      concurrency: 5,
    });
    d.register({
      type: 'job.ordered',
      mode: 'external',
      async handle({ row }) {
        if (row.payload.i === 1 && !failedOnce) {
          failedOnce = true;
          throw new RetryableJobError('transient', 0);
        }
        order.push(row.payload.i as number);
      },
    });
    for (let round = 0; round < 20 && order.length < 5; round++) {
      await d.tick();
      t.clock.advanceSeconds(1);
    }
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('a timer scheduled at T runs at T (±1 s) with the fake clock', async () => {
    const at = new Date(t.clock.now().getTime() + 10_000);
    await t.db.transaction((tx) => schedule(tx, 'job.timer', at, { orgId: ORG, dedupeKey: 'timer:1' }));
    const ran: Date[] = [];
    const d = new OutboxDispatcher(t.db, t.clock, silentLogger, { workerId: 'W' });
    d.register({ type: 'job.timer', mode: 'tx', handle: async () => void ran.push(t.clock.now()) });
    t.clock.advanceSeconds(9);
    expect(await d.tick()).toBe(0);
    t.clock.advanceSeconds(1);
    expect(await d.tick()).toBe(1);
    expect(Math.abs(ran[0]!.getTime() - at.getTime())).toBeLessThanOrEqual(1000);
  });

  it('a handler that keeps failing ends as dead with last_error', async () => {
    await t.db.transaction((tx) => enqueue(tx, { type: 'job.flaky', orgId: ORG, maxAttempts: 3 }));
    const dead: string[] = [];
    const d = new OutboxDispatcher(
      t.db,
      t.clock,
      silentLogger,
      { workerId: 'W' },
      { onDead: async (r) => void dead.push(r.id) },
    );
    d.register({
      type: 'job.flaky',
      mode: 'external',
      handle: async () => {
        throw new Error('boom');
      },
    });
    for (let i = 0; i < 10; i++) {
      await d.tick();
      t.clock.advanceSeconds(400);
    }
    const row = (await t.db.query(`SELECT status, attempts, last_error FROM outbox_events`)).rows[0];
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(3);
    expect(row.last_error).toContain('boom');
    expect(dead).toHaveLength(1);
  });

  it('a permanent error fails the row without retrying', async () => {
    await t.db.transaction((tx) => enqueue(tx, { type: 'job.perm', orgId: ORG }));
    const d = new OutboxDispatcher(t.db, t.clock, silentLogger, { workerId: 'W' });
    d.register({
      type: 'job.perm',
      mode: 'external',
      handle: async () => {
        throw new PermanentJobError('template not approved');
      },
    });
    await d.tick();
    const row = (await t.db.query(`SELECT status, attempts FROM outbox_events`)).rows[0];
    expect(row).toEqual({ status: 'failed', attempts: 1 });
  });

  it('dedupe_key collapses duplicate pending jobs; a periodic job can schedule its successor', async () => {
    await t.db.transaction(async (tx) => {
      expect(
        await enqueue(tx, { type: 'job.dispatch_pass', orgId: ORG, dedupeKey: 'dispatch_pass:P1' }),
      ).not.toBeNull();
      expect(
        await enqueue(tx, { type: 'job.dispatch_pass', orgId: ORG, dedupeKey: 'dispatch_pass:P1' }),
      ).toBeNull();
    });
    const d = new OutboxDispatcher(t.db, t.clock, silentLogger, { workerId: 'W' });
    d.register({
      type: 'job.dispatch_pass',
      mode: 'tx',
      async handle({ tx }) {
        await schedule(tx!, 'job.dispatch_pass', new Date(t.clock.now().getTime() + 5000), {
          orgId: ORG,
          dedupeKey: 'dispatch_pass:P1',
        });
      },
    });
    expect(await d.tick()).toBe(1);
    const rows = (await t.db.query(`SELECT status FROM outbox_events ORDER BY seq`)).rows.map(
      (r) => r.status,
    );
    expect(rows).toEqual(['done', 'pending']);
  });

  it('enqueue refuses payloads with secret fields (DEC-38)', async () => {
    await expect(
      t.db.transaction((tx) =>
        enqueue(tx, { type: 'job.wa_send', orgId: ORG, payload: { claim_code: '123456' } }),
      ),
    ).rejects.toThrow(/sensitive/);
    await expect(
      t.db.transaction((tx) =>
        enqueue(tx, { type: 'job.wa_send', orgId: ORG, payload: { customer_phone: '+9665' } }),
      ),
    ).rejects.toThrow(/sensitive/);
    const cols = await t.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'outbox_events'`,
    );
    expect(cols.rows.map((r) => r.column_name).some((c: string) => /secret|code|token/.test(c))).toBe(false);
  });

  it('domain events are marked done after projectors run', async () => {
    await t.db.transaction((tx) =>
      enqueue(tx, { type: 'ticket.created', orgId: ORG, payload: { ticket_id: 'x' } }),
    );
    const projected: string[] = [];
    const d = new OutboxDispatcher(t.db, t.clock, silentLogger, { workerId: 'W' });
    d.registerProjector({
      name: 'test',
      accepts: (ty) => ty.startsWith('ticket.'),
      project: async (_tx, row) => void projected.push(row.type),
    });
    await d.tick();
    expect(projected).toEqual(['ticket.created']);
  });
});
