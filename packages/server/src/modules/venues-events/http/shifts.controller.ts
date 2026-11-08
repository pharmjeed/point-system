import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequirePermission, created } from '../../../http/decorators.js';
import { CreateShiftBody, ListShiftsQuery, VersionOnlyBody } from '../application/schemas.js';
import { ShiftsService } from '../application/shifts.service.js';
import type { CommandMeta } from '../application/support.js';
import { CommandContext, input } from './support.js';

/** Canon §9.5: shifts (`shift.manage`). */
@Controller('v1')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get('venues/:venueId/shifts')
  @RequirePermission('shift.manage')
  list(
    @CurrentActor() actor: ActorContext,
    @Param('venueId') venueId: string,
    @Query(input(ListShiftsQuery)) q: ListShiftsQuery,
  ) {
    return this.shifts.list(actor, venueId, q);
  }

  @Post('venues/:venueId/shifts')
  @RequirePermission('shift.manage')
  @Command('POST /v1/venues/{venueId}/shifts')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(CreateShiftBody)) body: CreateShiftBody,
  ) {
    return created(await this.shifts.create(tx, actor, meta, venueId, body));
  }

  @Post('shifts/:shiftId/open')
  @RequirePermission('shift.manage')
  @Command('POST /v1/shifts/{shiftId}/open')
  open(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('shiftId') shiftId: string,
    @Body(input(VersionOnlyBody)) body: VersionOnlyBody,
  ) {
    return this.shifts.open(tx, actor, meta, shiftId, body);
  }

  @Post('shifts/:shiftId/close')
  @RequirePermission('shift.manage')
  @Command('POST /v1/shifts/{shiftId}/close')
  close(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @CommandContext() meta: CommandMeta,
    @Param('shiftId') shiftId: string,
    @Body(input(VersionOnlyBody)) body: VersionOnlyBody,
  ) {
    return this.shifts.close(tx, actor, meta, shiftId, body);
  }
}
