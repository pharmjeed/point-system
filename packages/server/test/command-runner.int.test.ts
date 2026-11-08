import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand, type CommandContext } from '../src/core/idempotency/command-runner.js';
import { requestHash } from '../src/core/idempotency/request-hash.js';
import { audit } from '../src/core/audit/audit-writer.js';
import { AppError } from '../src/core/errors/app-error.js';
import { ORG, USER, insertOrgAndUser, setupDb, type TestContext } from './helpers.js';

// PNT-008 and PNT-009 acceptance criteria.
describe('command runner (idempotency)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupDb();
    await insertOrgAndUser(t.db);
    await t.db.query(`CREATE TABLE IF NOT EXISTS test_effects (id serial PRIMARY KEY, label text)`);
  });
  afterAll(async () => t.close());

  const ctx = (key: string, body: unknown = { a: 1 }, path = '/v1/things/1/do'): CommandContext => ({
    userId: USER,
    idempotencyKey: key,
    operation: 'POST /v1/things/{id}/do',
    requestHash: requestHash('POST', path, body),
    requestId: 'req_test',
  });
  const effects = async (label: string) =>
    (await t.db.query(`SELECT count(*)::int AS n FROM test_effects WHERE label = $1`, [label])).rows[0]
      .n as number;

  const command =
    (label: string, delayMs = 0) =>
    async (tx: any) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await tx.query(`INSERT INTO test_effects (label) VALUES ($1)`, [label]);
      await audit(tx, { orgId: ORG, actor: { type: 'user', id: USER }, action: 'test.do' });
      return { data: { label }, status: 201 };
    };

  it('replays the saved response for the same key and body without a second effect', async () => {
    const first = await runCommand(t.db, ctx('key-replay-0001'), command('replay'));
    const second = await runCommand(t.db, ctx('key-replay-0001'), command('replay'));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.replayed).toBe(true);
    expect((second.body as any).data).toEqual((first.body as any).data);
    expect((second.body as any).meta.replayed).toBe(true);
    expect(await effects('replay')).toBe(1);
  });

  it('the same key with a different body is IDEMPOTENCY_KEY_REUSED (422)', async () => {
    await runCommand(t.db, ctx('key-reused-0001', { a: 1 }), command('reused'));
    const r = await runCommand(t.db, ctx('key-reused-0001', { a: 2 }), command('reused'));
    expect(r.status).toBe(422);
    expect((r.body as any).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await effects('reused')).toBe(1);
  });

  it('two concurrent requests with the same key: one executes, the other waits and returns the same response', async () => {
    const [a, b] = await Promise.all([
      runCommand(t.db, ctx('key-concurrent-01'), command('concurrent', 300)),
      (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return runCommand(t.db, ctx('key-concurrent-01'), command('concurrent', 0));
      })(),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await effects('concurrent')).toBe(1);
  });

  it('IDEMPOTENCY_IN_PROGRESS only when the wait on the key row exceeds lock_timeout', async () => {
    const slowDb = t.db;
    const original = slowDb.config.lockTimeoutMs;
    (slowDb.config as any).lockTimeoutMs = 200;
    try {
      const [a, b] = await Promise.all([
        runCommand(slowDb, ctx('key-inprogress-1'), command('inprogress', 800)),
        (async () => {
          await new Promise((r) => setTimeout(r, 50));
          return runCommand(slowDb, ctx('key-inprogress-1'), command('inprogress', 0));
        })(),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(409);
      expect((b.body as any).error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect((b.body as any).error.retryable).toBe(true);
    } finally {
      (slowDb.config as any).lockTimeoutMs = original;
    }
  });

  it('a deterministic 4xx is saved and replayed; its writes are rolled back', async () => {
    const failing = async (tx: any) => {
      await tx.query(`INSERT INTO test_effects (label) VALUES ('rejected')`);
      throw new AppError('TASK_ALREADY_CLAIMED', { task_id: 't1' });
    };
    const a = await runCommand(t.db, ctx('key-4xx-000001'), failing);
    const b = await runCommand(t.db, ctx('key-4xx-000001'), failing);
    expect(a.status).toBe(409);
    expect((a.body as any).error.code).toBe('TASK_ALREADY_CLAIMED');
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    expect(await effects('rejected')).toBe(0);
  });

  it('keepEffects commits the rejection side effects together with the saved error (wrong handover code)', async () => {
    const wrongCode = async (tx: any) => {
      await tx.query(`INSERT INTO test_effects (label) VALUES ('attempt')`);
      throw new AppError('HANDOVER_CODE_INVALID', { attempts_left: 4 }, { keepEffects: true });
    };
    const a = await runCommand(t.db, ctx('key-keep-00001'), wrongCode);
    const b = await runCommand(t.db, ctx('key-keep-00001'), wrongCode);
    expect(a.status).toBe(422);
    expect(b.replayed).toBe(true);
    expect(await effects('attempt')).toBe(1); // the replay does not consume a second attempt
  });

  it('5xx is not saved: the key row disappears and a retry executes', async () => {
    let calls = 0;
    const flaky = async (tx: any) => {
      calls++;
      if (calls === 1) throw new AppError('SERVICE_UNAVAILABLE');
      return command('after-5xx')(tx);
    };
    const a = await runCommand(t.db, ctx('key-5xx-000001'), flaky);
    expect(a.status).toBe(503);
    const keys = await t.db.query(
      `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'key-5xx-000001'`,
    );
    expect(keys.rows[0].n).toBe(0);
    const b = await runCommand(t.db, ctx('key-5xx-000001'), flaky);
    expect(b.status).toBe(201);
    expect(b.replayed).toBe(false);
  });

  it('a crash after COMMIT and a retry returns the saved response without a duplicate effect', async () => {
    const a = await runCommand(t.db, ctx('key-crash-00001'), command('crash'));
    // the client never saw `a` (connection dropped); it retries with the same key
    const b = await runCommand(t.db, ctx('key-crash-00001'), command('crash'));
    expect(b.replayed).toBe(true);
    expect(b.body).toMatchObject({ data: (a.body as any).data });
    expect(await effects('crash')).toBe(1);
  });

  it('fails a command that commits without writing an audit_log row (PNT-009)', async () => {
    const noAudit = async (tx: any) => {
      await tx.query(`INSERT INTO test_effects (label) VALUES ('no-audit')`);
      return { data: {} };
    };
    await expect(runCommand(t.db, ctx('key-noaudit-001'), noAudit, { assertAudit: true })).rejects.toThrow(
      /audit_log/,
    );
    expect(await effects('no-audit')).toBe(0);
  });
});
