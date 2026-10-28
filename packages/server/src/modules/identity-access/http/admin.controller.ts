import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  Command,
  CurrentActor,
  CurrentTx,
  RequestId,
  RequirePermission,
  created,
} from '../../../http/decorators.js';
import { DATABASE } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { AdminService } from '../application/admin-service.js';
import { reasonBody } from './reason-pipe.js';
import {
  AssignmentBody,
  DriverCreateBody,
  DriverPatchBody,
  DriversQuery,
  ReasonBody,
  ScopesBody,
  StaffCreateBody,
  StaffPatchBody,
  StaffQuery,
} from './schemas.js';

const uuidParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'id' }),
});

/** Canon §9.6 — drivers and staff (PNT-015, PNT-016, PNT-017). */
@Controller('v1')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Get('drivers')
  @RequirePermission('driver.read')
  listDrivers(
    @CurrentActor() actor: ActorContext,
    @Query(zodBody(DriversQuery)) q: z.infer<typeof DriversQuery>,
  ) {
    if (q.venue_id && !actor.orgScope && !actor.venueIds.has(q.venue_id))
      throw new AppError('SCOPE_VENUE_DENIED', { venue_id: q.venue_id });
    return this.admin.listDrivers(this.db, actor, q);
  }

  @Post('drivers')
  @RequirePermission('driver.manage')
  @Command('POST /v1/drivers')
  async createDriver(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(DriverCreateBody)) body: z.infer<typeof DriverCreateBody>,
    @RequestId() rid: string,
  ) {
    return created(await this.admin.createDriver(tx, actor, body, rid));
  }

  @Get('drivers/:driverId')
  @RequirePermission('driver.read')
  getDriver(@CurrentActor() actor: ActorContext, @Param('driverId', uuidParam) id: string) {
    return this.admin.getDriver(this.db, actor, id);
  }

  @Patch('drivers/:driverId')
  @RequirePermission('driver.manage')
  @Command('PATCH /v1/drivers/{driverId}')
  patchDriver(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('driverId', uuidParam) id: string,
    @Body(zodBody(DriverPatchBody)) body: z.infer<typeof DriverPatchBody>,
    @RequestId() rid: string,
  ) {
    return this.admin.patchDriver(tx, actor, id, body, rid);
  }

  @Post('drivers/:driverId/disable')
  @RequirePermission('driver.manage')
  @Command('POST /v1/drivers/{driverId}/disable')
  disable(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('driverId', uuidParam) id: string,
    @Body(reasonBody(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @RequestId() rid: string,
  ) {
    return this.admin.disableDriver(tx, actor, id, body, rid);
  }

  @Post('drivers/:driverId/enable')
  @RequirePermission('driver.manage')
  @Command('POST /v1/drivers/{driverId}/enable')
  enable(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('driverId', uuidParam) id: string,
    @RequestId() rid: string,
  ) {
    return this.admin.enableDriver(tx, actor, id, rid);
  }

  @Post('drivers/:driverId/reset-secret')
  @RequirePermission('driver.manage')
  @Command('POST /v1/drivers/{driverId}/reset-secret')
  resetSecret(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('driverId', uuidParam) id: string,
    @RequestId() rid: string,
  ) {
    return this.admin.resetDriverSecret(tx, actor, id, rid);
  }

  @Get('drivers/:driverId/assignments')
  @RequirePermission('driver.read')
  assignments(@CurrentActor() actor: ActorContext, @Param('driverId', uuidParam) id: string) {
    return this.admin.listAssignments(this.db, actor, id);
  }

  @Post('drivers/:driverId/assignments')
  @RequirePermission('driver.assign')
  @Command('POST /v1/drivers/{driverId}/assignments')
  async assign(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('driverId', uuidParam) id: string,
    @Body(zodBody(AssignmentBody)) body: z.infer<typeof AssignmentBody>,
    @RequestId() rid: string,
  ) {
    return created(await this.admin.createAssignment(tx, actor, id, body, rid));
  }

  @Get('staff')
  @RequirePermission('staff.manage')
  listStaff(@CurrentActor() actor: ActorContext, @Query(zodBody(StaffQuery)) q: z.infer<typeof StaffQuery>) {
    return this.admin.listStaff(this.db, actor, q);
  }

  @Post('staff')
  @RequirePermission('staff.manage')
  @Command('POST /v1/staff')
  async createStaff(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(StaffCreateBody)) body: z.infer<typeof StaffCreateBody>,
    @RequestId() rid: string,
  ) {
    return created(await this.admin.createStaff(tx, actor, body, rid));
  }

  @Patch('staff/:userId')
  @RequirePermission('staff.manage')
  @Command('PATCH /v1/staff/{userId}')
  patchStaff(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('userId', uuidParam) id: string,
    @Body(zodBody(StaffPatchBody)) body: z.infer<typeof StaffPatchBody>,
    @RequestId() rid: string,
  ) {
    return this.admin.patchStaff(tx, actor, id, body, rid);
  }

  @Post('staff/:userId/scopes')
  @RequirePermission('staff.manage')
  @Command('POST /v1/staff/{userId}/scopes')
  scopes(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('userId', uuidParam) id: string,
    @Body(zodBody(ScopesBody)) body: z.infer<typeof ScopesBody>,
    @RequestId() rid: string,
  ) {
    return this.admin.updateScopes(tx, actor, id, body, rid);
  }

  @Post('staff/:userId/reset-mfa')
  @RequirePermission('staff.manage')
  @Command('POST /v1/staff/{userId}/reset-mfa')
  resetMfa(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('userId', uuidParam) id: string,
    @Body(reasonBody(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @RequestId() rid: string,
  ) {
    return this.admin.resetMfa(tx, actor, id, body, rid);
  }
}
