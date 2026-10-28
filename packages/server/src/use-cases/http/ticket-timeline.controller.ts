import { Controller, Get, Param } from '@nestjs/common';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import { CurrentActor, RequestId, RequirePermission } from '../../http/decorators.js';
import { TicketTimelineQuery } from '../ticket-timeline.js';
import { ticketIdParam } from './pipes.js';

/** Canon §9.2 `GET /v1/tickets/{ticketId}/timeline` — the full history of a ticket (PNT-076, S-03). */
@Controller('v1/tickets')
export class TicketTimelineController {
  constructor(private readonly timeline: TicketTimelineQuery) {}

  @Get(':ticketId/timeline')
  @RequirePermission('ticket.read_full')
  getTimeline(
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
  ) {
    return this.timeline.execute(actor, id, rid);
  }
}
