import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequirePermission, created } from '../../../http/decorators.js';
import { EventsService } from '../application/events.service.js';
import {
  CancelEventBody,
  CreateEventBody,
  ListEventsQuery,
  UpdateEventBody,
  VersionOnlyBody,
} from '../application/schemas.js';
import type { CommandMeta } from '../application/support.js';
import { CommandContext, input } from './support.js';

/**
 * Canon §9.5: events (`event.manage`). The close and the reconciliation are the CloseEvent use-case
 * (use-cases/http, 04 §4.4); the operations board belongs to the supervisor screens.
 */
@Controller('v1')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get('venues/:venueId/events')
  @RequirePermission('event.manage')
  list(
    @CurrentActor() actor: ActorContext,
    @Param('venueId') venueId: string,
    @Query(input(ListEventsQuery)) q: ListEventsQuery,
  ) {
    return this.events.list(actor, venueId, q);
  }

  @Post('venues/:venueId/events')
  @RequirePermission('event.manage')
  @Command('POST /v1/venues/{venueId}/events')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(CreateEventBody)) body: CreateEventBody,
  ) {
    return created(await this.events.create(tx, actor, meta, venueId, body));
  }

  @Get('events/:eventId')
  @RequirePermission('event.manage')
  get(@CurrentActor() actor: ActorContext, @Param('eventId') eventId: string) {
    return this.events.get(actor, eventId);
  }

  @Patch('events/:eventId')
  @RequirePermission('event.manage')
  @Command('PATCH /v1/events/{eventId}')
  update(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('eventId') eventId: string,
    @Body(input(UpdateEventBody)) body: UpdateEventBody,
  ) {
    return this.events.update(tx, actor, meta, eventId, body);
  }

  @Post('events/:eventId/open')
  @RequirePermission('event.manage')
  @Command('POST /v1/events/{eventId}/open')
  open(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('eventId') eventId: string,
    @Body(input(VersionOnlyBody)) body: VersionOnlyBody,
  ) {
    return this.events.open(tx, actor, meta, eventId, body);
  }

  @Post('events/:eventId/start-closing')
  @RequirePermission('event.manage')
  @Command('POST /v1/events/{eventId}/start-closing')
  startClosing(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('eventId') eventId: string,
    @Body(input(VersionOnlyBody)) body: VersionOnlyBody,
  ) {
    return this.events.startClosing(tx, actor, meta, eventId, body);
  }

  @Post('events/:eventId/cancel')
  @RequirePermission('event.manage')
  @Command('POST /v1/events/{eventId}/cancel')
  cancel(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('eventId') eventId: string,
    @Body(input(CancelEventBody)) body: CancelEventBody,
  ) {
    return this.events.cancel(tx, actor, meta, eventId, body);
  }
}
