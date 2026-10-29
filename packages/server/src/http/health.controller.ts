import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ERROR_CATALOG } from '@point/shared';
import type { Response } from 'express';
import type { Clock } from '../core/clock/clock.js';
import type { Database } from '../core/db/database.js';
import { errorEnvelope } from '../core/errors/envelope.js';
import { outboxLagThresholdS } from '../core/settings/ops-settings.js';
import { Public, RawBody, RequestId } from './decorators.js';
import { CLOCK, DATABASE } from './tokens.js';

/**
 * The readiness probe answers within this bound, the wait for a connection included: the container health
 * check gives it 3 s (infra/compose/docker-compose.prod.yml), and a database that stopped answering must read as
 * «unavailable», not as a probe that hangs (17 §12, DEC-PROPOSED-8).
 */
export const READY_TIMEOUT_MS = 2000;

/** The age of the oldest due outbox row and every organization's settings, in one bounded query. */
const READY_SQL = `
  SELECT (SELECT floor(EXTRACT(EPOCH FROM ($1::timestamptz - min(e.available_at))))::int
            FROM outbox_events e
           WHERE (e.status = 'pending' AND e.available_at <= $1)
              OR (e.status = 'processing' AND e.locked_until < $1)) AS outbox_lag_s,
         (SELECT coalesce(json_agg(o.settings), '[]'::json) FROM organizations o) AS settings`;

/** /health/live and /health/ready carry no business data (canon §9.8). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('live')
  @Public()
  @HttpCode(200)
  live() {
    return new RawBody({ status: 'ok' });
  }

  /**
   * 07 `healthReady`: 200 `{status, checks: {db: true, outbox_lag_s}}` — `degraded` while the oldest due outbox row is
   * older than the lowest `ops.outbox_lag_alert_s` (the `outbox_lag` condition of 14 §8: the instance still serves,
   * the operator sees why); a database that does not answer within READY_TIMEOUT_MS is `503 SERVICE_UNAVAILABLE` in
   * the canon envelope (request_id, retryable, Retry-After) — answered here, not thrown, so a probe polled every few
   * seconds during an outage does not log a stack each time (the outage is logged by the requests that meet it).
   */
  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) res: Response, @RequestId() requestId: string) {
    let row: { outbox_lag_s: number | null; settings: unknown[] | null } | undefined;
    try {
      row = (await this.db.boundedQuery(READY_SQL, [this.clock.now()], READY_TIMEOUT_MS)).rows[0];
    } catch {
      res.status(ERROR_CATALOG.SERVICE_UNAVAILABLE.http).setHeader('Retry-After', '1');
      return new RawBody(errorEnvelope('SERVICE_UNAVAILABLE', {}, requestId));
    }
    const lag = typeof row?.outbox_lag_s === 'number' ? Math.max(0, row.outbox_lag_s) : null;
    const thresholds = (row?.settings ?? []).map(outboxLagThresholdS);
    const degraded = lag !== null && thresholds.length > 0 && lag > Math.min(...thresholds);
    return new RawBody({ status: degraded ? 'degraded' : 'ok', checks: { db: true, outbox_lag_s: lag } });
  }
}
