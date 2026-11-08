import {
  Controller,
  Get,
  Module,
  Post,
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createTestDatabase, type TestDatabase } from '@point/db/testing';
import {
  AppError,
  Command,
  CurrentTx,
  Database,
  FakeClock,
  Public,
  audit,
  enqueue,
  type Tx,
} from '@point/server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap.js';
import { CSRF, testEnv } from './test-env.js';

const ORG = '00000000-0000-4000-8000-0000000000a0';
const USER = '00000000-0000-4000-8000-0000000000a1';

@Injectable()
class FakeActorGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    ctx.switchToHttp().getRequest().actor = { userId: USER, role: 'driver' };
    return true;
  }
}

@Controller('v1/test')
class TestController {
  @Get('boom')
  @Public()
  boom() {
    throw new AppError('TASK_ALREADY_CLAIMED', { task_id: 'abc' });
  }

  @Get('crash')
  @Public()
  crash() {
    throw new TypeError('secret internals');
  }

  @Post('cmd')
  @Public() // the fake guard below stands in for a session
  @Command('POST /v1/test/cmd')
  async cmd(@CurrentTx() tx: Tx) {
    await audit(tx, { orgId: ORG, actor: { type: 'user', id: USER }, action: 'test.cmd' });
    const r = await tx.one(`SELECT 1 AS one`);
    return { one: r.one };
  }
}

@Module({ controllers: [TestController], providers: [{ provide: APP_GUARD, useClass: FakeActorGuard }] })
class TestModule {}

// PNT-006 acceptance.
describe('API skeleton', () => {
  let tdb: TestDatabase;
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = new Database({ connectionString: tdb.url }, new FakeClock());
    await db.query(`INSERT INTO organizations (id, name_ar) VALUES ($1, 'x')`, [ORG]);
    await db.query(
      `INSERT INTO users (id, org_id, employee_code, full_name, phone_e164, role, secret_kind, secret_hash) VALUES ($1,$2,'D-1','x','+966500000009','driver','pin','x')`,
      [USER, ORG],
    );
    app = await createApp({
      env: testEnv({ DATABASE_URL: tdb.url }),
      database: db,
      extraModules: [TestModule],
    });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await db.close();
    await tdb.drop();
  });

  it('unknown route → 404 RESOURCE_NOT_FOUND envelope with request_id', async () => {
    const r = await request(app.getHttpServer()).get('/v1/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(r.body.error.request_id).toMatch(/^req_/);
    expect(r.headers['x-request-id']).toBe(r.body.error.request_id);
    expect(r.body.error.message_ar).toBeTruthy();
  });

  it('a domain error returns its catalog HTTP status and message_ar', async () => {
    const r = await request(app.getHttpServer())
      .get('/v1/test/boom')
      .set('X-Request-Id', 'req_client_supplied_1');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'TASK_ALREADY_CLAIMED',
      retryable: false,
      request_id: 'req_client_supplied_1',
      details: { task_id: 'abc' },
    });
  });

  it('unexpected errors become INTERNAL_ERROR without internals', async () => {
    const r = await request(app.getHttpServer()).get('/v1/test/crash');
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(r.body)).not.toContain('secret internals');
  });

  it('unsafe methods without the CSRF header are PERMISSION_DENIED (reason csrf)', async () => {
    const r = await request(app.getHttpServer()).post('/v1/test/cmd').send({});
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'csrf' } });
  });

  it('a ✓ command without Idempotency-Key → 428; with a key it runs and replays', async () => {
    const none = await request(app.getHttpServer()).post('/v1/test/cmd').set(CSRF).send({ a: 1 });
    expect(none.status).toBe(428);
    expect(none.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const first = await request(app.getHttpServer())
      .post('/v1/test/cmd')
      .set(CSRF)
      .set('Idempotency-Key', 'k-0000000001')
      .send({ a: 1 });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ one: 1 });
    expect(first.body.meta.request_id).toMatch(/^req_/);
    const again = await request(app.getHttpServer())
      .post('/v1/test/cmd')
      .set(CSRF)
      .set('Idempotency-Key', 'k-0000000001')
      .send({ a: 1 });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.meta.replayed).toBe(true);
  });

  it('/health/live and /health/ready are ok; API responses are not cached', async () => {
    expect((await request(app.getHttpServer()).get('/health/live')).body).toEqual({ status: 'ok' });
    const ready = await request(app.getHttpServer()).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { db: true, outbox_lag_s: null } }); // 07 healthReady
    const r = await request(app.getHttpServer()).get('/v1/test/boom');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('/health/ready is degraded while the outbox lags beyond ops.outbox_lag_alert_s (07, 14 §8)', async () => {
    const at = (s: number) => new Date(Date.now() - s * 1000); // the app runs on the system clock here
    const row = await db.transaction((tx) =>
      enqueue(tx, { type: 'job.dispatch_sweep', orgId: ORG, availableAt: at(10), dedupeKey: 'ready-a' }),
    );
    try {
      let r = await request(app.getHttpServer()).get('/health/ready');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok'); // 10 s is under the 30 s default
      expect(r.body.checks.outbox_lag_s).toBeGreaterThanOrEqual(10);
      await db.query(`UPDATE outbox_events SET available_at = $2 WHERE id = $1`, [row, at(60)]);
      r = await request(app.getHttpServer()).get('/health/ready');
      expect(r.status).toBe(200); // still ready: it serves, the operator sees why
      expect(r.body.status).toBe('degraded');
      expect(r.body.checks.db).toBe(true);
      expect(r.body.checks.outbox_lag_s).toBeGreaterThanOrEqual(60);
    } finally {
      await db.query(`DELETE FROM outbox_events WHERE id = $1`, [row]);
    }
  });

  it('/health/ready fails when the database is down: 503 SERVICE_UNAVAILABLE in the canon envelope', async () => {
    const dead = new Database({ connectionString: 'postgres://x:y@127.0.0.1:1/none' }, new FakeClock());
    const app2 = await createApp({ env: testEnv(), database: dead });
    await app2.init();
    try {
      const r = await request(app2.getHttpServer()).get('/health/ready');
      expect(r.status).toBe(503);
      expect(r.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
      expect(r.body.error.request_id).toMatch(/^req_/);
      expect(r.headers['retry-after']).toBeTruthy();
    } finally {
      await app2.close();
      await dead.close().catch(() => {});
    }
  });
});
