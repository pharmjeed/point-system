import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { TelemetryBatchSchema, type TelemetryBatch } from '@point/shared';
import type { Request } from 'express';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { CurrentActor, RawBody, RequestId, RequirePermission } from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { TelemetryIngest } from '../application/telemetry-service.js';

/**
 * `POST /v1/telemetry` (`telemetry.write`, canon §9.7 without ✓): `202 Accepted` with no body (15 §9.2).
 * Not a @Command: no Idempotency-Key and no audit row (09 §3: telemetry is not audited); the ingest opens
 * its own transaction for the batch.
 */
@Controller('v1')
export class TelemetryController {
  constructor(private readonly ingest: TelemetryIngest) {}

  @Post('telemetry')
  @RequirePermission('telemetry.write')
  @HttpCode(202)
  async post(
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(TelemetryBatchSchema)) body: TelemetryBatch,
    @Req() req: Request & { rawBody?: Buffer },
    @RequestId() requestId: string,
  ) {
    const bytes = req.rawBody?.length ?? Buffer.byteLength(JSON.stringify(req.body ?? {}));
    await this.ingest.ingest(actor, body, bytes, requestId);
    return new RawBody(undefined);
  }
}
