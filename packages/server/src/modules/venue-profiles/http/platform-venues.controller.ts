import { Body, Controller, Get, Header, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApproveVenueBodySchema,
  ReviewReasonBodySchema,
  VenuePricingBodySchema,
  VenuePublicStatusSchema,
} from '@point/shared';
import { z } from 'zod';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentPlatformActor,
  CurrentTx,
  RequirePlatformPermission,
} from '../../../http/decorators.js';
import {
  PlatformReviewService,
  type PlatformCommandMeta,
  type PlatformVenueListQuery,
} from '../application/platform-review.service.js';
import { ProfileCommand, input, reasoned } from './support.js';

const ListQuery = z.strictObject({
  status: VenuePublicStatusSchema.optional(),
  org_id: z.uuid().optional(),
  city: z.string().trim().min(1).max(80).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Reasoned = { expected_version: number; reason: string };
type Pricing = {
  expected_version: number;
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: number | null;
};

/** P-04 (V2-004): the platform's review of the venue listings, and the venue prices of P-05 (DEC-493). */
@Controller('v1/platform/venues')
export class PlatformVenuesController {
  constructor(private readonly review: PlatformReviewService) {}

  @Get()
  @RequirePlatformPermission('platform.venue_review')
  list(@Query(input(ListQuery)) q: PlatformVenueListQuery) {
    return this.review.list(q);
  }

  @Get(':venueId')
  @RequirePlatformPermission('platform.venue_review')
  @Header('Cache-Control', 'private, no-store') // carries presigned photo links
  get(@Param('venueId') venueId: string) {
    return this.review.get(venueId);
  }

  @Post(':venueId/approve')
  @RequirePlatformPermission('platform.venue_review')
  @Command('POST /v1/platform/venues/{venueId}/approve')
  approve(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @ProfileCommand() meta: PlatformCommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(ApproveVenueBodySchema)) body: { expected_version: number },
  ) {
    return this.review.approve(tx, actor, meta, venueId, body.expected_version);
  }

  @Post(':venueId/send-back')
  @RequirePlatformPermission('platform.venue_review')
  @Command('POST /v1/platform/venues/{venueId}/send-back')
  sendBack(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @ProfileCommand() meta: PlatformCommandMeta,
    @Param('venueId') venueId: string,
    @Body(reasoned(ReviewReasonBodySchema)) body: Reasoned,
  ) {
    return this.review.sendBack(tx, actor, meta, venueId, body);
  }

  @Post(':venueId/hide')
  @RequirePlatformPermission('platform.venue_review')
  @Command('POST /v1/platform/venues/{venueId}/hide')
  hide(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @ProfileCommand() meta: PlatformCommandMeta,
    @Param('venueId') venueId: string,
    @Body(reasoned(ReviewReasonBodySchema)) body: Reasoned,
  ) {
    return this.review.hide(tx, actor, meta, venueId, body);
  }

  @Post(':venueId/unhide')
  @RequirePlatformPermission('platform.venue_review')
  @Command('POST /v1/platform/venues/{venueId}/unhide')
  unhide(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @ProfileCommand() meta: PlatformCommandMeta,
    @Param('venueId') venueId: string,
    @Body(reasoned(ReviewReasonBodySchema)) body: Reasoned,
  ) {
    return this.review.unhide(tx, actor, meta, venueId, body);
  }

  @Put(':venueId/pricing')
  @RequirePlatformPermission('platform.plan_manage')
  @Command('PUT /v1/platform/venues/{venueId}/pricing')
  pricing(
    @CurrentTx() tx: Tx,
    @CurrentPlatformActor() actor: PlatformActorContext,
    @ProfileCommand() meta: PlatformCommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(VenuePricingBodySchema)) body: Pricing,
  ) {
    return this.review.pricing(tx, actor, meta, venueId, body);
  }
}
