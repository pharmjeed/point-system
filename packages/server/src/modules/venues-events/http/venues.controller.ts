import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequirePermission, created } from '../../../http/decorators.js';
import { DispatchPoolsService } from '../application/dispatch-pools.service.js';
import {
  CreateDispatchPoolBody,
  CreateVenueBody,
  ListVenuesQuery,
  PutVenueSettingsBody,
  UpdateDispatchPoolBody,
  UpdateVenueBody,
} from '../application/schemas.js';
import type { CommandMeta } from '../application/support.js';
import { VenuesService } from '../application/venues.service.js';
import { CommandContext, input } from './support.js';

/** Canon §9.5: venues, venue settings and dispatch pools. */
@Controller('v1')
export class VenuesController {
  constructor(
    private readonly venues: VenuesService,
    private readonly pools: DispatchPoolsService,
  ) {}

  @Get('venues')
  @RequirePermission('venue.read')
  list(@CurrentActor() actor: ActorContext, @Query(input(ListVenuesQuery)) q: ListVenuesQuery) {
    return this.venues.list(actor, q);
  }

  @Post('venues')
  @RequirePermission('venue.manage')
  @Command('POST /v1/venues')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Body(input(CreateVenueBody)) body: CreateVenueBody,
  ) {
    return created(await this.venues.create(tx, actor, meta, body));
  }

  @Get('venues/:venueId')
  @RequirePermission('venue.read')
  get(@CurrentActor() actor: ActorContext, @Param('venueId') venueId: string) {
    return this.venues.get(actor, venueId);
  }

  @Patch('venues/:venueId')
  @RequirePermission('venue.manage')
  @Command('PATCH /v1/venues/{venueId}')
  update(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(UpdateVenueBody)) body: UpdateVenueBody,
  ) {
    return this.venues.update(tx, actor, meta, venueId, body);
  }

  @Get('venues/:venueId/settings')
  @RequirePermission('venue.read')
  getSettings(@CurrentActor() actor: ActorContext, @Param('venueId') venueId: string) {
    return this.venues.getSettings(actor, venueId);
  }

  @Put('venues/:venueId/settings')
  @RequirePermission('venue.manage')
  @Command('PUT /v1/venues/{venueId}/settings')
  putSettings(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(PutVenueSettingsBody)) body: PutVenueSettingsBody,
  ) {
    return this.venues.putSettings(tx, actor, meta, venueId, body);
  }

  @Get('venues/:venueId/dispatch-pools')
  @RequirePermission('venue.read')
  listPools(@CurrentActor() actor: ActorContext, @Param('venueId') venueId: string) {
    return this.pools.list(actor, venueId);
  }

  @Post('venues/:venueId/dispatch-pools')
  @RequirePermission('venue.manage')
  @Command('POST /v1/venues/{venueId}/dispatch-pools')
  async createPool(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(CreateDispatchPoolBody)) body: CreateDispatchPoolBody,
  ) {
    return created(await this.pools.create(tx, actor, meta, venueId, body));
  }

  @Patch('dispatch-pools/:poolId')
  @RequirePermission('venue.manage')
  @Command('PATCH /v1/dispatch-pools/{poolId}')
  updatePool(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('poolId') poolId: string,
    @Body(input(UpdateDispatchPoolBody)) body: UpdateDispatchPoolBody,
  ) {
    return this.pools.update(tx, actor, meta, poolId, body);
  }
}
