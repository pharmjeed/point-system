import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import type { Tx } from '../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../http/decorators.js';
import { zodBody } from '../../http/zod-pipe.js';
import { CloseEventUseCase, EventCloseQueries } from '../close-event.js';

/** 07: `POST /v1/events/{eventId}/close` body (optional, strict). */
export const CloseEventRequest = z.strictObject({
  expected_version: z.number().int().min(1).optional(),
  note: z.string().max(500).nullable().optional(),
});

/**
 * Canon §9.5 — the event close (PNT-087): the reconciliation read (S-10) and the close command. Both compose
 * venues-events with tickets-custody, dispatch and payments-reports, so they live with the use-cases
 * (04 §4.3 rule 2); start-closing is a single-module command of venues-events.
 */
@Controller('v1/events')
export class EventCloseController {
  constructor(
    private readonly close: CloseEventUseCase,
    private readonly queries: EventCloseQueries,
  ) {}

  @Get(':eventId/reconciliation')
  @RequirePermission('event.manage')
  reconciliation(@CurrentActor() actor: ActorContext, @Param('eventId') eventId: string) {
    return this.queries.reconciliation(actor, eventId);
  }

  @Post(':eventId/close')
  @RequirePermission('event.manage')
  @Command('POST /v1/events/{eventId}/close')
  closeEvent(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('eventId') eventId: string,
    @Body(zodBody(CloseEventRequest)) body: z.infer<typeof CloseEventRequest>,
  ) {
    return this.close.execute(tx, actor, eventId, body, rid);
  }
}

@Module({
  controllers: [EventCloseController],
  providers: [CloseEventUseCase, EventCloseQueries],
})
export class EventCloseHttpModule {}
