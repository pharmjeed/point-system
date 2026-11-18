import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  PlatformAlertResolveBodySchema,
  PlatformAlertsQuerySchema,
  PlatformPaymentsQuerySchema,
  PlatformReconciliationRunsQuerySchema,
  RefundIssueBodySchema,
  type PlatformAlertResolveBody,
  type PlatformAlertsQuery,
  type PlatformPaymentsQuery,
  type PlatformReconciliationRunsQuery,
  type RefundIssueBody,
} from '@point/shared';
import type { Request } from 'express';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentPlatformActor,
  CurrentTx,
  Public,
  RawBody,
  RequirePlatformPermission,
  created,
} from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { PlatformPaymentsConsole } from '../application/platform-console.js';
import { RefundsService } from '../application/refunds.js';
import { PaymentWebhookIntake } from '../application/webhooks.js';

/**
 * Canon §9.8 V2 row — `POST /webhooks/payments/moyasar` (V2-021, DEC-511, DEC-512). Public (the gateway has no
 * session) and CSRF-exempt by path; the raw body is read as bytes (bootstrap.ts), its shared secret checked before it
 * is parsed, then stored and acknowledged with 200 and no body (a redelivery too).
 */
@Controller('webhooks/payments/moyasar')
export class PaymentWebhookController {
  constructor(private readonly intake: PaymentWebhookIntake) {}

  @Post()
  @Public()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    await this.intake.receive(req.rawBody);
    return new RawBody('');
  }
}

/**
 * P-06 / P-08 — the refund of an online payment (`platform.refund_issue`, V2-021, DEC-513), and P-08's reads of the
 * payments (`platform.payment_read`, V2-024, DEC-529).
 */
@Controller('v1/platform/payments')
export class PlatformRefundsController {
  constructor(
    private readonly refunds: RefundsService,
    private readonly console: PlatformPaymentsConsole,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.payment_read')
  list(@Query(zodBody(PlatformPaymentsQuerySchema)) q: PlatformPaymentsQuery) {
    return this.console.payments(q);
  }

  @Get(':paymentId')
  @RequirePlatformPermission('platform.payment_read')
  detail(@Param('paymentId') paymentId: string) {
    return this.console.payment(paymentId);
  }

  @Post(':paymentId/refunds')
  @RequirePlatformPermission('platform.refund_issue')
  @Command('POST /v1/platform/payments/{paymentId}/refunds')
  async issue(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('paymentId') paymentId: string,
    @Body(zodBody(RefundIssueBodySchema)) body: RefundIssueBody,
    @Client() client: ClientInfo,
  ) {
    return created(await this.refunds.issue(tx, actor, paymentId, body, client));
  }
}

/** P-08 — the daily reconciliation runs with the gateway (V2-024, DEC-514, DEC-529). */
@Controller('v1/platform/reconciliation-runs')
export class PlatformReconciliationController {
  constructor(private readonly console: PlatformPaymentsConsole) {}

  @Get()
  @RequirePlatformPermission('platform.payment_read')
  list(@Query(zodBody(PlatformReconciliationRunsQuerySchema)) q: PlatformReconciliationRunsQuery) {
    return this.console.runs(q);
  }

  @Get(':runId')
  @RequirePlatformPermission('platform.payment_read')
  detail(@Param('runId') runId: string) {
    return this.console.run(runId);
  }
}

/** P-08 — the platform's finance alerts and their resolution with a note (V2-024, DEC-514, DEC-530). */
@Controller('v1/platform/alerts')
export class PlatformAlertsController {
  constructor(private readonly console: PlatformPaymentsConsole) {}

  @Get()
  @RequirePlatformPermission('platform.payment_read')
  list(@Query(zodBody(PlatformAlertsQuerySchema)) q: PlatformAlertsQuery) {
    return this.console.alerts(q);
  }

  @Post(':alertId/resolve')
  @RequirePlatformPermission('platform.payment_read')
  @Command('POST /v1/platform/alerts/{alertId}/resolve')
  resolve(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('alertId') alertId: string,
    @Body(zodBody(PlatformAlertResolveBodySchema)) body: PlatformAlertResolveBody,
    @Client() client: ClientInfo,
  ) {
    return this.console.resolve(tx, actor, alertId, body, client);
  }
}
