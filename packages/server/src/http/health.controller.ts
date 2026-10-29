import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Database } from '../core/db/database.js';
import { Public, RawBody } from './decorators.js';
import { DATABASE } from './tokens.js';

/**
 * The readiness probe answers within this bound, the wait for a connection included: the container health
 * check gives it 3 s (infra/compose/docker-compose.prod.yml), and a database that stopped answering must read as
 * «unavailable», not as a probe that hangs (17 §12, DEC-PROPOSED-8).
 */
export const READY_TIMEOUT_MS = 2000;

/** /health/live and /health/ready carry no data (canon §9.8). */
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get('live')
  @Public()
  @HttpCode(200)
  live() {
    return new RawBody({ status: 'ok' });
  }

  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      await this.db.ping(READY_TIMEOUT_MS);
      return new RawBody({ status: 'ok' });
    } catch {
      res.status(503);
      return new RawBody({ status: 'unavailable' });
    }
  }
}
