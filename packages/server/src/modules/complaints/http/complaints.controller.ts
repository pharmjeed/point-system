import { Body, Controller, Get, Header, Inject, Param, Post, Query } from '@nestjs/common';
import {
  PlatformComplaintStatusBodySchema,
  PlatformComplaintsQuerySchema,
  type PlatformComplaintStatusBody,
  type PlatformComplaintsQuery,
} from '@point/shared';
import { CUSTOMER_ROUTES } from '@point/shared/customer';
import type { z } from 'zod';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentCustomer,
  CurrentPlatformActor,
  CurrentTx,
  RequireCustomer,
  RequirePlatformPermission,
  created,
} from '../../../http/decorators.js';
import { DATABASE } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { CustomerComplaints, PlatformComplaints } from '../application/complaints.js';

const R = CUSTOMER_ROUTES;
type Out<S extends z.ZodType> = z.output<S>;

/** C-21 / C-22 (V2-037; DEC-603): the account's complaints, Bearer, an Idempotency-Key on the new one. */
@Controller('v1/customer/complaints')
export class CustomerComplaintsController {
  constructor(
    private readonly complaints: CustomerComplaints,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Get()
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  async list(@CurrentCustomer() actor: CustomerActorContext) {
    return { items: await this.complaints.list(this.db, actor.accountId) };
  }

  @Post()
  @RequireCustomer()
  @Command('POST /v1/customer/complaints')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.complaintCreate.body)) body: Out<typeof R.complaintCreate.body>,
    @Client() client: ClientInfo,
  ) {
    return created(await this.complaints.create(tx, actor, body, client));
  }

  @Get(':complaintId')
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  one(@CurrentCustomer() actor: CustomerActorContext, @Param('complaintId') id: string) {
    return this.complaints.one(this.db, actor.accountId, id);
  }
}

/** P-13 «الشكاوى» (V2-037; DEC-604; `platform.complaint_manage`). */
@Controller('v1/platform/complaints')
export class PlatformComplaintsController {
  constructor(private readonly complaints: PlatformComplaints) {}

  @Get()
  @RequirePlatformPermission('platform.complaint_manage')
  @Header('Cache-Control', 'private, no-store')
  list(@Query(zodBody(PlatformComplaintsQuerySchema)) q: PlatformComplaintsQuery) {
    return this.complaints.list(q);
  }

  @Get(':complaintId')
  @RequirePlatformPermission('platform.complaint_manage')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentPlatformActor() _actor: PlatformActorContext, @Param('complaintId') id: string) {
    return this.complaints.detail(id);
  }

  @Post(':complaintId/status')
  @RequirePlatformPermission('platform.complaint_manage')
  @Command('POST /v1/platform/complaints/{complaintId}/status')
  status(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('complaintId') id: string,
    @Body(zodBody(PlatformComplaintStatusBodySchema)) body: PlatformComplaintStatusBody,
    @Client() client: ClientInfo,
  ) {
    return this.complaints.setStatus(tx, actor, id, body, client);
  }
}
