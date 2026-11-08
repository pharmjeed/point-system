import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RefundIssueBodySchema, type RefundIssueBody } from '@point/shared';
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

/** P-06 / P-08 — the refund of an online payment (`platform.refund_issue`, V2-021, DEC-513). */
@Controller('v1/platform/payments')
export class PlatformRefundsController {
  constructor(private readonly refunds: RefundsService) {}

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
