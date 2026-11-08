import { Body, Controller, Get, Header, Inject, Param, Post, Query } from '@nestjs/common';
import {
  PlatformPlanCreateBodySchema,
  PlatformPlanRetireBodySchema,
  PlatformPlansQuerySchema,
  PlatformSubscriptionsQuerySchema,
  PlatformSubscriptionsReportQuerySchema,
  type PlatformPlanCreateBody,
  type PlatformPlanRetireBody,
  type PlatformPlansQuery,
  type PlatformSubscriptionsQuery,
  type PlatformSubscriptionsReportQuery,
} from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentPlatformActor,
  CurrentTx,
  RequirePlatformPermission,
  created,
} from '../../../http/decorators.js';
import { CLOCK } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { Client } from '../../identity-access/http/client-info.js';
import { PlatformPlansService } from '../application/plans.js';
import { PlatformSubscriptionsService } from '../application/reports.js';

/**
 * P-05 «باقات الاشتراك» (V2-030, `platform.plan_manage`: owner and finance; DEC-531): the venues and their plans, a
 * new plan (a price change replaces one), a plan retired with a reason — each command with its Idempotency-Key.
 */
@Controller('v1/platform/plans')
export class PlatformPlansController {
  constructor(private readonly plans: PlatformPlansService) {}

  @Get()
  @RequirePlatformPermission('platform.plan_manage')
  @Header('Cache-Control', 'private, no-store')
  list(@Query(zodBody(PlatformPlansQuerySchema)) q: PlatformPlansQuery) {
    return this.plans.list(q);
  }

  @Post()
  @RequirePlatformPermission('platform.plan_manage')
  @Command('POST /v1/platform/plans')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Body(zodBody(PlatformPlanCreateBodySchema)) body: PlatformPlanCreateBody,
    @Client() client: ClientInfo,
  ) {
    return created(await this.plans.create(tx, actor, body, client));
  }

  @Post(':planId/retire')
  @RequirePlatformPermission('platform.plan_manage')
  @Command('POST /v1/platform/plans/{planId}/retire')
  retire(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('planId') planId: string,
    @Body(zodBody(PlatformPlanRetireBodySchema)) body: PlatformPlanRetireBody,
    @Client() client: ClientInfo,
  ) {
    return this.plans.retire(tx, actor, planId, body, client);
  }
}

/**
 * P-07 «الاشتراكات» (V2-035, `platform.subscription_read`: owner and finance; DEC-537): the list with its filters,
 * one subscription with its periods, payments and timeline, and the report (MRR, renewals due, churn, per venue).
 * Customers are masked; nothing here is cached by a browser.
 */
@Controller('v1/platform/subscriptions')
export class PlatformSubscriptionsController {
  constructor(
    private readonly subs: PlatformSubscriptionsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.subscription_read')
  @Header('Cache-Control', 'private, no-store')
  list(@Query(zodBody(PlatformSubscriptionsQuerySchema)) q: PlatformSubscriptionsQuery) {
    return this.subs.list(q);
  }

  @Get('report')
  @RequirePlatformPermission('platform.subscription_read')
  @Header('Cache-Control', 'private, no-store')
  report(@Query(zodBody(PlatformSubscriptionsReportQuerySchema)) q: PlatformSubscriptionsReportQuery) {
    return this.subs.report(q, this.clock.now());
  }

  @Get(':subscriptionId')
  @RequirePlatformPermission('platform.subscription_read')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentPlatformActor() _actor: PlatformActorContext, @Param('subscriptionId') id: string) {
    return this.subs.detail(id);
  }
}
