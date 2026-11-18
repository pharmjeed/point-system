import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  type PipeTransform,
} from '@nestjs/common';
import { CUSTOMER_ROUTES, CustomerVisitListQuerySchema } from '@point/shared/customer';
import type { z } from 'zod';
import type { CustomerActorContext } from '../../core/actor-context/customer-actor.js';
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import { parseEncryptionKey, type EncryptionKey } from '../../core/crypto/crypto.js';
import type { Database } from '../../core/db/database.js';
import type { Tx } from '../../core/db/tx.js';
import { AppError } from '../../core/errors/app-error.js';
import { Command, CurrentCustomer, CurrentTx, RequireCustomer, created } from '../../http/decorators.js';
import { CLOCK, DATABASE, ENV } from '../../http/tokens.js';
import { zodBody, zodToFields } from '../../http/zod-pipe.js';
import {
  customerVisitDetail,
  findAccountVisit,
  listCustomerVisits,
  rateCustomerVisit,
  registerCustomerDevice,
  type VisitDetailDeps,
} from '../../modules/customer-accounts/index.js';
import type { ClientInfo } from '../../modules/identity-access/application/auth-service.js';
import { Client } from '../../modules/identity-access/http/client-info.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../modules/media/index.js';
import { requestVisitFromApp, visitHandoverCode } from '../customer-visits.js';

const R = CUSTOMER_ROUTES;
type Out<S extends z.ZodType> = z.output<S>;

class VisitListQueryPipe implements PipeTransform<unknown, Out<typeof CustomerVisitListQuerySchema>> {
  transform(value: unknown) {
    const r = CustomerVisitListQuerySchema.safeParse(value ?? {});
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    return r.data;
  }
}

/**
 * V2-015 / V2-016 (DEC-516 … DEC-520): the customer's visits — C-16 «زياراتي», C-12 «سيارتي الآن» with
 * «اطلب السيارة» and the handover code, C-13 the rating — and the push registration of the device. Bearer sessions of
 * `/v1/customer/*` only (DEC-497); the request composes the dispatch use-case, so the controller lives with the
 * use-cases (04 §4.3 rule 2).
 */
@Controller('v1/customer')
export class CustomerVisitsController {
  private readonly keys: EncryptionKey[];

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    this.keys = [parseEncryptionKey(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID)];
  }

  private detailDeps(): VisitDetailDeps {
    return { storage: this.storage, now: this.clock.now(), ttlS: this.env.MEDIA_READ_URL_TTL_S };
  }

  @Get('visits')
  @RequireCustomer()
  async visits(
    @CurrentCustomer() actor: CustomerActorContext,
    @Query(new VisitListQueryPipe()) query: Out<typeof CustomerVisitListQuerySchema>,
  ) {
    const page = await listCustomerVisits(this.db, actor.accountId, query);
    return { data: { items: page.items }, next_cursor: page.nextCursor };
  }

  @Get('visits/:ticketId')
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  async visit(@CurrentCustomer() actor: CustomerActorContext, @Param('ticketId') ticketId: string) {
    const v = await findAccountVisit(this.db, actor.accountId, ticketId);
    return customerVisitDetail(this.db, this.detailDeps(), v);
  }

  @Post('visits/:ticketId/request')
  @RequireCustomer()
  @Command('POST /v1/customer/visits/{ticketId}/request')
  async request(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('ticketId') ticketId: string,
    @Body(zodBody(R.visitRequest.body)) _body: Out<typeof R.visitRequest.body>,
    @Client() client: ClientInfo,
  ) {
    return created(await requestVisitFromApp(tx, this.detailDeps(), actor, ticketId, client));
  }

  @Get('visits/:ticketId/handover-code')
  @RequireCustomer()
  @Header('Cache-Control', 'private, no-store')
  handoverCode(
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('ticketId') ticketId: string,
    @Client() client: ClientInfo,
  ) {
    return visitHandoverCode(this.db, this.keys, actor, ticketId, client);
  }

  @Post('visits/:ticketId/rating')
  @RequireCustomer()
  @Command('POST /v1/customer/visits/{ticketId}/rating')
  async rating(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Param('ticketId') ticketId: string,
    @Body(zodBody(R.visitRating.body)) body: Out<typeof R.visitRating.body>,
    @Client() client: ClientInfo,
  ) {
    return created(await rateCustomerVisit(tx, actor, ticketId, body, client));
  }

  @Post('devices')
  @RequireCustomer()
  @Command('POST /v1/customer/devices')
  devices(
    @CurrentTx() tx: Tx,
    @CurrentCustomer() actor: CustomerActorContext,
    @Body(zodBody(R.devices.body)) body: Out<typeof R.devices.body>,
    @Client() client: ClientInfo,
  ) {
    return registerCustomerDevice(tx, actor, body, client);
  }
}
