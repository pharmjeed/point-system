import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Database } from '../core/db/database.js';
import { Public, RawBody } from './decorators.js';
import { DATABASE } from './tokens.js';

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
      await this.db.query('SELECT 1');
      return new RawBody({ status: 'ok' });
    } catch {
      res.status(503);
      return new RawBody({ status: 'unavailable' });
    }
  }
}
