import { Body, Controller, Get, Header, Inject, Param, Post, Query } from '@nestjs/common';
import {
  OperatorSettlementsQuerySchema,
  PlatformSettlementsQuerySchema,
  SettlementAdjustmentBodySchema,
  SettlementDisputeBodySchema,
  SettlementGenerateBodySchema,
  SettlementIssueBodySchema,
  SettlementPaymentBodySchema,
  SettlementReasonBodySchema,
  type OperatorSettlementsQuery,
  type PlatformSettlementsQuery,
  type SettlementAdjustmentBody,
  type SettlementDisputeBody,
  type SettlementGenerateBody,
  type SettlementIssueBody,
  type SettlementPaymentBody,
  type SettlementReasonBody,
} from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentActor,
  CurrentPlatformActor,
  CurrentTx,
  RequirePermission,
  RequirePlatformPermission,
} from '../../../http/decorators.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { InvoicingRuntime, operatorInvoice } from '../../invoicing/index.js';
import { generateCommand } from '../application/monthly.js';
import { OperatorSettlementQueries, PlatformSettlementsQueries } from '../application/reads.js';
import { SettlementCommands } from '../application/statements.js';

/**
 * P-09 «التسوية» (V2-041 / V2-042, PLATFORM_ROUTES; DEC-544 … DEC-546): the operators' monthly statements —
 * `platform.settlement_manage` (finance and the owner). Every command takes its Idempotency-Key and the statement's
 * `expected_version`.
 */
@Controller('v1/platform/settlements')
export class PlatformSettlementsController {
  constructor(
    private readonly queries: PlatformSettlementsQueries,
    private readonly commands: SettlementCommands,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.settlement_manage')
  list(@Query(zodBody(PlatformSettlementsQuerySchema)) q: PlatformSettlementsQuery) {
    return this.queries.list(q);
  }

  @Post('generate')
  @RequirePlatformPermission('platform.settlement_manage')
  @Command('POST /v1/platform/settlements/generate')
  generate(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Body(zodBody(SettlementGenerateBodySchema)) body: SettlementGenerateBody,
    @Client() client: ClientInfo,
  ) {
    return generateCommand(tx, actor, body, this.env.VAT_RATE_BP, client);
  }

  @Get(':statementId')
  @RequirePlatformPermission('platform.settlement_manage')
  detail(@Param('statementId') statementId: string) {
    return this.queries.detail(statementId);
  }

  @Post(':statementId/adjustments')
  @RequirePlatformPermission('platform.settlement_manage')
  @Command('POST /v1/platform/settlements/{statementId}/adjustments')
  adjust(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('statementId') statementId: string,
    @Body(zodBody(SettlementAdjustmentBodySchema)) body: SettlementAdjustmentBody,
    @Client() client: ClientInfo,
  ) {
    return this.commands.adjust(tx, actor, statementId, body, client);
  }

  @Post(':statementId/issue')
  @RequirePlatformPermission('platform.settlement_manage')
  @Command('POST /v1/platform/settlements/{statementId}/issue')
  issue(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('statementId') statementId: string,
    @Body(zodBody(SettlementIssueBodySchema)) body: SettlementIssueBody,
    @Client() client: ClientInfo,
  ) {
    return this.commands.issue(tx, actor, statementId, body.expected_version, client);
  }

  @Post(':statementId/record-payment')
  @RequirePlatformPermission('platform.settlement_manage')
  @Command('POST /v1/platform/settlements/{statementId}/record-payment')
  recordPayment(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('statementId') statementId: string,
    @Body(zodBody(SettlementPaymentBodySchema)) body: SettlementPaymentBody,
    @Client() client: ClientInfo,
  ) {
    return this.commands.recordPayment(tx, actor, statementId, body, client);
  }

  @Post(':statementId/resolve-dispute')
  @RequirePlatformPermission('platform.settlement_manage')
  @Command('POST /v1/platform/settlements/{statementId}/resolve-dispute')
  resolveDispute(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('statementId') statementId: string,
    @Body(zodBody(SettlementReasonBodySchema)) body: SettlementReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.commands.resolveDispute(tx, actor, statementId, body, client);
  }

  @Post(':statementId/void')
  @RequirePlatformPermission('platform.settlement_manage')
  @Command('POST /v1/platform/settlements/{statementId}/void')
  void(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('statementId') statementId: string,
    @Body(zodBody(SettlementReasonBodySchema)) body: SettlementReasonBody,
    @Client() client: ClientInfo,
  ) {
    return this.commands.void(tx, actor, statementId, body, client);
  }
}

/** O-05 «كشف التسوية» (V2-041, canon §9.7 V2 rows; DEC-547): the operator's own statements and its dispute. */
@Controller('v1/settlement-statements')
export class OperatorSettlementsController {
  constructor(
    private readonly queries: OperatorSettlementQueries,
    private readonly commands: SettlementCommands,
  ) {}

  @Get()
  @RequirePermission('settlement.read')
  list(
    @CurrentActor() actor: ActorContext,
    @Query(zodBody(OperatorSettlementsQuerySchema)) q: OperatorSettlementsQuery,
  ) {
    return this.queries.list(actor.orgId, q);
  }

  @Get(':statementId')
  @RequirePermission('settlement.read')
  detail(@CurrentActor() actor: ActorContext, @Param('statementId') statementId: string) {
    return this.queries.detail(actor.orgId, statementId);
  }

  @Post(':statementId/dispute')
  @RequirePermission('settlement.dispute')
  @Command('POST /v1/settlement-statements/{statementId}/dispute')
  dispute(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('statementId') statementId: string,
    @Body(zodBody(SettlementDisputeBodySchema)) body: SettlementDisputeBody,
    @Client() client: ClientInfo,
  ) {
    return this.commands.dispute(tx, actor, statementId, body, client);
  }
}

/** O-06 «اشتراك النظام» (V2-042, canon §9.7 V2 rows; DEC-547): the operator's contract, venues and POINT's invoices. */
@Controller('v1/system-subscription')
export class OperatorSystemSubscriptionController {
  constructor(
    private readonly queries: OperatorSettlementQueries,
    private readonly rt: InvoicingRuntime,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @RequirePermission('settlement.read')
  view(@CurrentActor() actor: ActorContext) {
    return this.queries.systemSubscription(actor.orgId);
  }

  @Get('invoices/:invoiceId')
  @RequirePermission('settlement.read')
  @Header('Cache-Control', 'private, no-store')
  invoice(@CurrentActor() actor: ActorContext, @Param('invoiceId') invoiceId: string) {
    return operatorInvoice(this.db, this.rt.storage(), this.rt.env, this.clock, actor.orgId, invoiceId);
  }
}
