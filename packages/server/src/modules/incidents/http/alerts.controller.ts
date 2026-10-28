import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { AlertsService } from '../application/alerts.service.js';
import { AlertNoteBody, ListAlertsQuery } from './schemas.js';

const alertIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'alert' }),
});

const ACK = 'POST /v1/alerts/{alertId}/acknowledge';
const RESOLVE = 'POST /v1/alerts/{alertId}/resolve';

/** Canon §9.7 — the supervisor alerts center (PNT-075, S-04). */
@Controller('v1/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermission('alert.read')
  list(@CurrentActor() actor: ActorContext, @Query(zodBody(ListAlertsQuery)) q: ListAlertsQuery) {
    return this.alerts.list(actor, q);
  }

  @Post(':alertId/acknowledge')
  @RequirePermission('alert.manage')
  @Command(ACK)
  acknowledge(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() requestId: string,
    @Param('alertId', alertIdParam) alertId: string,
    @Body(zodBody(AlertNoteBody)) body: AlertNoteBody,
  ) {
    return this.alerts.acknowledge(tx, actor, { operation: ACK, requestId }, alertId, body);
  }

  @Post(':alertId/resolve')
  @RequirePermission('alert.manage')
  @Command(RESOLVE)
  resolve(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() requestId: string,
    @Param('alertId', alertIdParam) alertId: string,
    @Body(zodBody(AlertNoteBody)) body: AlertNoteBody,
  ) {
    return this.alerts.resolve(tx, actor, { operation: RESOLVE, requestId }, alertId, body);
  }
}
