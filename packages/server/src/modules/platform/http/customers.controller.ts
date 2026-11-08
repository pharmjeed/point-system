import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import {
  PlatformCustomerReasonBodySchema,
  PlatformCustomersQuerySchema,
  type PlatformCustomerReasonBody,
  type PlatformCustomersQuery,
} from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentPlatformActor,
  CurrentTx,
  RequirePlatformPermission,
} from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { PlatformCustomersService } from '../application/customers-service.js';

/**
 * P-06 «العملاء» (V2-024, PLATFORM_ROUTES; DEC-526 … DEC-528): the platform's search and view of a customer account
 * (`platform.customer_read`: owner, finance, support) and its suspend / reactivate / sign-out-everywhere commands with
 * a reason (`platform.customer_manage`), each with its Idempotency-Key (platform_idempotency_keys). The reads carry
 * personal data: never cached by a browser or a proxy.
 */
@Controller('v1/platform/customers')
export class PlatformCustomersController {
  constructor(private readonly customers: PlatformCustomersService) {}

  @Get()
  @RequirePlatformPermission('platform.customer_read')
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Query(zodBody(PlatformCustomersQuerySchema)) q: PlatformCustomersQuery,
    @Client() client: ClientInfo,
  ) {
    return this.customers.list(actor, q, client);
  }

  @Get(':accountId')
  @RequirePlatformPermission('platform.customer_read')
  @Header('Cache-Control', 'private, no-store')
  detail(
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('accountId') accountId: string,
    @Client() client: ClientInfo,
  ) {
    return this.customers.detail(actor, accountId, client);
  }

  @Post(':accountId/suspend')
  @RequirePlatformPermission('platform.customer_manage')
  @Command('POST /v1/platform/customers/{accountId}/suspend')
  suspend(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('accountId') accountId: string,
    @Body(zodBody(PlatformCustomerReasonBodySchema)) body: PlatformCustomerReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.customers.command(tx, actor, accountId, 'suspend', body, client);
  }

  @Post(':accountId/reactivate')
  @RequirePlatformPermission('platform.customer_manage')
  @Command('POST /v1/platform/customers/{accountId}/reactivate')
  reactivate(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('accountId') accountId: string,
    @Body(zodBody(PlatformCustomerReasonBodySchema)) body: PlatformCustomerReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.customers.command(tx, actor, accountId, 'reactivate', body, client);
  }

  @Post(':accountId/sessions/revoke')
  @RequirePlatformPermission('platform.customer_manage')
  @Command('POST /v1/platform/customers/{accountId}/sessions/revoke')
  revokeSessions(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('accountId') accountId: string,
    @Body(zodBody(PlatformCustomerReasonBodySchema)) body: PlatformCustomerReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.customers.command(tx, actor, accountId, 'revoke_sessions', body, client);
  }
}
