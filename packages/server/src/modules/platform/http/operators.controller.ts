import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentPlatformActor,
  CurrentTx,
  RequirePlatformPermission,
  created,
  oneTimeResponse,
} from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { OperatorsService } from '../application/operators-service.js';
import {
  CreateContractBody,
  CreateOperatorBody,
  EmptyBody,
  EndContractBody,
  OperatorReasonBody,
  OperatorsQuery,
  OptionalReasonBody,
} from './schemas.js';

/**
 * V2-003 / V2-005 — the platform console's operators (PLATFORM_ROUTES): P-01 overview, P-02 operators, P-03 the
 * operator (contracts, staff read-only, its first owner's temporary password) and the operator lifecycle of
 * docs/v2/02 §4. Every command carries its Idempotency-Key (platform_idempotency_keys).
 */
@Controller('v1/platform')
export class PlatformOperatorsController {
  constructor(private readonly operators: OperatorsService) {}

  @Get('overview')
  @RequirePlatformPermission('platform.overview_read')
  overview() {
    return this.operators.overview();
  }

  @Get('operators')
  @RequirePlatformPermission('platform.operator_read')
  list(@Query(zodBody(OperatorsQuery)) q: OperatorsQuery) {
    return this.operators.list(q);
  }

  @Post('operators')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Body(zodBody(CreateOperatorBody)) body: CreateOperatorBody,
    @Client() client: ClientInfo,
  ) {
    const r = await this.operators.create(tx, actor, body, client);
    return oneTimeResponse(r.data, r.stored, 201);
  }

  @Get('operators/:orgId')
  @RequirePlatformPermission('platform.operator_read')
  detail(@Param('orgId') orgId: string) {
    return this.operators.detail(orgId);
  }

  @Get('operators/:orgId/users')
  @RequirePlatformPermission('platform.operator_read')
  users(@Param('orgId') orgId: string) {
    return this.operators.users(orgId);
  }

  @Get('operators/:orgId/contracts')
  @RequirePlatformPermission('platform.operator_read')
  contracts(@Param('orgId') orgId: string) {
    return this.operators.contracts(orgId);
  }

  @Post('operators/:orgId/contracts')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators/{orgId}/contracts')
  async createContract(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('orgId') orgId: string,
    @Body(zodBody(CreateContractBody)) body: CreateContractBody,
    @Client() client: ClientInfo,
  ) {
    return created(await this.operators.createContract(tx, actor, orgId, body, client));
  }

  @Post('operators/:orgId/contracts/:contractId/end')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators/{orgId}/contracts/{contractId}/end')
  endContract(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('orgId') orgId: string,
    @Param('contractId') contractId: string,
    @Body(zodBody(EndContractBody)) body: EndContractBody,
    @Client() client: ClientInfo,
  ) {
    return this.operators.endContract(tx, actor, orgId, contractId, body, client);
  }

  @Post('operators/:orgId/owner/temporary-password')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators/{orgId}/owner/temporary-password')
  async reissueOwnerPassword(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('orgId') orgId: string,
    @Body(zodBody(EmptyBody)) _body: unknown,
    @Client() client: ClientInfo,
  ) {
    const r = await this.operators.reissueOwnerPassword(tx, actor, orgId, client);
    return oneTimeResponse(r.data, r.stored);
  }

  @Post('operators/:orgId/activate')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators/{orgId}/activate')
  activate(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('orgId') orgId: string,
    @Body(zodBody(OptionalReasonBody)) body: OptionalReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.operators.transition(tx, actor, orgId, 'activate', body, client);
  }

  @Post('operators/:orgId/suspend')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators/{orgId}/suspend')
  suspend(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('orgId') orgId: string,
    @Body(zodBody(OperatorReasonBody)) body: OperatorReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.operators.transition(tx, actor, orgId, 'suspend', body, client);
  }

  @Post('operators/:orgId/reactivate')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators/{orgId}/reactivate')
  reactivate(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('orgId') orgId: string,
    @Body(zodBody(OptionalReasonBody)) body: OptionalReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.operators.transition(tx, actor, orgId, 'reactivate', body, client);
  }

  @Post('operators/:orgId/terminate')
  @RequirePlatformPermission('platform.operator_manage')
  @Command('POST /v1/platform/operators/{orgId}/terminate')
  terminate(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('orgId') orgId: string,
    @Body(zodBody(OperatorReasonBody)) body: OperatorReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.operators.transition(tx, actor, orgId, 'terminate', body, client);
  }
}
