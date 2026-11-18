import { Body, Controller, Get, Header, Inject, Param, Post, Query } from '@nestjs/common';
import {
  PlatformEligibilityDecisionBodySchema,
  PlatformEligibleStudentsBodySchema,
  PlatformExceptionalRefundBodySchema,
  PlatformVenueClosureCancelBodySchema,
  PlatformVenueClosureCreateBodySchema,
  PlatformVenueClosuresQuerySchema,
  type PlatformEligibilityDecisionBody,
  type PlatformEligibleStudentsBody,
  type PlatformExceptionalRefundBody,
  type PlatformVenueClosureCancelBody,
  type PlatformVenueClosureCreateBody,
  type PlatformVenueClosuresQuery,
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
import { VenueClosuresService } from '../application/closures.js';
import { PlatformEligibilityService } from '../application/eligibility.js';
import { ExceptionalRefunds } from '../application/exceptional-refund.js';
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
    private readonly eligibility: PlatformEligibilityService,
    private readonly exceptional: ExceptionalRefunds,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.subscription_read')
  @Header('Cache-Control', 'private, no-store')
  list(@Query(zodBody(PlatformSubscriptionsQuerySchema)) q: PlatformSubscriptionsQuery) {
    return this.subs.list(q, this.clock.now());
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
    return this.subs.detail(id, this.clock.now());
  }

  /** V2-036 (DEC-596): approve or reject an application waiting for its eligibility decision. */
  @Post(':subscriptionId/eligibility')
  @RequirePlatformPermission('platform.subscription_manage')
  @Command('POST /v1/platform/subscriptions/{subscriptionId}/eligibility')
  async decide(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('subscriptionId') id: string,
    @Body(zodBody(PlatformEligibilityDecisionBodySchema)) body: PlatformEligibilityDecisionBody,
    @Client() client: ClientInfo,
  ) {
    await this.eligibility.decide(tx, actor, id, body, client);
    return this.subs.detailIn(tx, id);
  }

  /** V2-036 (DEC-600): the exceptional prorated refund of the remaining counted days. */
  @Post(':subscriptionId/exceptional-refund')
  @RequirePlatformPermission('platform.refund_issue')
  @Command('POST /v1/platform/subscriptions/{subscriptionId}/exceptional-refund')
  async exceptionalRefund(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('subscriptionId') id: string,
    @Body(zodBody(PlatformExceptionalRefundBodySchema)) body: PlatformExceptionalRefundBody,
    @Client() client: ClientInfo,
  ) {
    const r = await this.exceptional.issue(tx, actor, id, body, client);
    return created({ ...r, subscription: await this.subs.detailIn(tx, id) });
  }
}

/** V2-036 (DEC-597): the venue's list of eligible student numbers (counts only on read). */
@Controller('v1/platform/venues')
export class PlatformEligibleStudentsController {
  constructor(private readonly eligibility: PlatformEligibilityService) {}

  @Get(':venueId/eligible-students')
  @RequirePlatformPermission('platform.subscription_manage')
  @Header('Cache-Control', 'private, no-store')
  summary(@Param('venueId') venueId: string) {
    return this.eligibility.listSummary(venueId);
  }

  @Post(':venueId/eligible-students')
  @RequirePlatformPermission('platform.subscription_manage')
  @Command('POST /v1/platform/venues/{venueId}/eligible-students')
  importList(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('venueId') venueId: string,
    @Body(zodBody(PlatformEligibleStudentsBodySchema)) body: PlatformEligibleStudentsBody,
    @Client() client: ClientInfo,
  ) {
    return this.eligibility.importList(tx, actor, venueId, body, client);
  }
}

/** V2-036 (DEC-599): P-05's announced holidays and closures of a venue. */
@Controller('v1/platform/venue-closures')
export class PlatformVenueClosuresController {
  constructor(
    private readonly closures: VenueClosuresService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.plan_manage')
  @Header('Cache-Control', 'private, no-store')
  list(@Query(zodBody(PlatformVenueClosuresQuerySchema)) q: PlatformVenueClosuresQuery) {
    return this.closures.list(q, this.clock.now());
  }

  @Post()
  @RequirePlatformPermission('platform.plan_manage')
  @Command('POST /v1/platform/venue-closures')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Body(zodBody(PlatformVenueClosureCreateBodySchema)) body: PlatformVenueClosureCreateBody,
    @Client() client: ClientInfo,
  ) {
    return created(await this.closures.create(tx, actor, body, client));
  }

  @Post(':closureId/cancel')
  @RequirePlatformPermission('platform.plan_manage')
  @Command('POST /v1/platform/venue-closures/{closureId}/cancel')
  cancel(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @Param('closureId') id: string,
    @Body(zodBody(PlatformVenueClosureCancelBodySchema)) body: PlatformVenueClosureCancelBody,
    @Client() client: ClientInfo,
  ) {
    return this.closures.cancel(tx, actor, id, body, client);
  }
}
