import { Body, Controller, Param, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import type { Tx } from '../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../http/decorators.js';
import { ManualReconcileUseCase } from '../manual-reconcile.js';
import { reasonBody, ticketIdParam } from './pipes.js';
import { ManualReconcileBody } from './supervisor-schemas.js';

/** Canon §9.3 `POST /v1/tickets/{ticketId}/manual-reconcile` — the true state after an outage (PNT-085, S-03). */
@Controller('v1/tickets')
export class ManualReconcileController {
  constructor(private readonly manualReconcile: ManualReconcileUseCase) {}

  @Post(':ticketId/manual-reconcile')
  @RequirePermission('ticket.manual_reconcile')
  @Command('POST /v1/tickets/{ticketId}/manual-reconcile')
  reconcile(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(reasonBody(ManualReconcileBody)) body: z.infer<typeof ManualReconcileBody>,
  ) {
    return this.manualReconcile.execute(tx, actor, id, body, rid);
  }
}
