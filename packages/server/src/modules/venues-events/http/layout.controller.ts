import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequirePermission, created } from '../../../http/decorators.js';
import { LayoutService } from '../application/layout.service.js';
import {
  CreateKeyBoardBody,
  CreateKeySlotsBody,
  CreateParkingSpotsBody,
  CreateParkingZoneBody,
  ListKeyBoardsQuery,
  ListSpotsQuery,
  ListZonesQuery,
  UpdateLabelledBody,
  UpdateParkingZoneBody,
} from '../application/schemas.js';
import type { CommandMeta } from '../application/support.js';
import { CommandContext, input } from './support.js';

/**
 * Canon §9.5: parking zones and spots, key boards and slots. Reads are `venue.layout_read` (drivers: the venue of
 * their active assignment, pick-list only, DEC-33); writes are `venue.manage`.
 */
@Controller('v1')
export class LayoutController {
  constructor(private readonly layout: LayoutService) {}

  @Get('venues/:venueId/parking-zones')
  @RequirePermission('venue.layout_read')
  listZones(
    @CurrentActor() actor: ActorContext,
    @Param('venueId') venueId: string,
    @Query(input(ListZonesQuery)) q: ListZonesQuery,
  ) {
    return this.layout.listZones(actor, venueId, q);
  }

  @Post('venues/:venueId/parking-zones')
  @RequirePermission('venue.manage')
  @Command('POST /v1/venues/{venueId}/parking-zones')
  async createZone(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(CreateParkingZoneBody)) body: CreateParkingZoneBody,
  ) {
    return created(await this.layout.createZone(tx, actor, meta, venueId, body));
  }

  @Patch('parking-zones/:zoneId')
  @RequirePermission('venue.manage')
  @Command('PATCH /v1/parking-zones/{zoneId}')
  updateZone(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('zoneId') zoneId: string,
    @Body(input(UpdateParkingZoneBody)) body: UpdateParkingZoneBody,
  ) {
    return this.layout.updateZone(tx, actor, meta, zoneId, body);
  }

  @Get('venues/:venueId/parking-spots')
  @RequirePermission('venue.layout_read')
  listSpots(
    @CurrentActor() actor: ActorContext,
    @Param('venueId') venueId: string,
    @Query(input(ListSpotsQuery)) q: ListSpotsQuery,
  ) {
    return this.layout.listSpots(actor, venueId, q);
  }

  @Post('venues/:venueId/parking-spots')
  @RequirePermission('venue.manage')
  @Command('POST /v1/venues/{venueId}/parking-spots')
  async createSpots(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(CreateParkingSpotsBody)) body: CreateParkingSpotsBody,
  ) {
    return created(await this.layout.createSpots(tx, actor, meta, venueId, body));
  }

  @Patch('parking-spots/:spotId')
  @RequirePermission('venue.manage')
  @Command('PATCH /v1/parking-spots/{spotId}')
  updateSpot(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('spotId') spotId: string,
    @Body(input(UpdateLabelledBody)) body: UpdateLabelledBody,
  ) {
    return this.layout.updateSpot(tx, actor, meta, spotId, body);
  }

  @Get('venues/:venueId/key-boards')
  @RequirePermission('venue.layout_read')
  listKeyBoards(
    @CurrentActor() actor: ActorContext,
    @Param('venueId') venueId: string,
    @Query(input(ListKeyBoardsQuery)) q: ListKeyBoardsQuery,
  ) {
    return this.layout.listKeyBoards(actor, venueId, q);
  }

  @Post('venues/:venueId/key-boards')
  @RequirePermission('venue.manage')
  @Command('POST /v1/venues/{venueId}/key-boards')
  async createKeyBoard(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(CreateKeyBoardBody)) body: CreateKeyBoardBody,
  ) {
    return created(await this.layout.createKeyBoard(tx, actor, meta, venueId, body));
  }

  @Post('key-boards/:boardId/slots')
  @RequirePermission('venue.manage')
  @Command('POST /v1/key-boards/{boardId}/slots')
  async createKeySlots(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('boardId') boardId: string,
    @Body(input(CreateKeySlotsBody)) body: CreateKeySlotsBody,
  ) {
    return created(await this.layout.createKeySlots(tx, actor, meta, boardId, body));
  }

  @Patch('key-slots/:slotId')
  @RequirePermission('venue.manage')
  @Command('PATCH /v1/key-slots/{slotId}')
  updateKeySlot(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('slotId') slotId: string,
    @Body(input(UpdateLabelledBody)) body: UpdateLabelledBody,
  ) {
    return this.layout.updateKeySlot(tx, actor, meta, slotId, body);
  }
}
