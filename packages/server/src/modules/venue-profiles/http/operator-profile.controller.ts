import { Body, Controller, Get, Header, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  PutVenuePublicProfileBodySchema,
  RequestVenuePhotoBodySchema,
  SubmitVenuePublicProfileBodySchema,
  type PutVenuePublicProfileBody,
} from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequirePermission, created } from '../../../http/decorators.js';
import { OperatorProfileService, type ProfileCommandMeta } from '../application/operator-profile.service.js';
import type { PhotoIngestPlan } from '../application/photo-ingest.js';
import { PhotoIngestPlanParam, PhotoIngestPreparer } from './photo-ingest.preparer.js';
import { ProfileCommand, input } from './support.js';

/** O-04 (V2-004): the venue's public profile in S-13 — owner and admin (`venue.manage`, org scope). */
@Controller('v1/venues/:venueId/public-profile')
export class OperatorProfileController {
  constructor(private readonly profiles: OperatorProfileService) {}

  @Get()
  @RequirePermission('venue.manage')
  @Header('Cache-Control', 'private, no-store') // carries presigned photo links
  get(@CurrentActor() actor: ActorContext, @Param('venueId') venueId: string) {
    return this.profiles.get(actor, venueId);
  }

  @Put()
  @RequirePermission('venue.manage')
  @Command('PUT /v1/venues/{venueId}/public-profile')
  @UseGuards(PhotoIngestPreparer) // the photos' storage phase, before the command transaction opens
  put(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @ProfileCommand() meta: ProfileCommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(PutVenuePublicProfileBodySchema)) body: PutVenuePublicProfileBody,
    @PhotoIngestPlanParam() plan: PhotoIngestPlan | undefined,
  ) {
    return this.profiles.put(tx, actor, meta, venueId, body, plan);
  }

  @Post('photos')
  @RequirePermission('venue.manage')
  @Command('POST /v1/venues/{venueId}/public-profile/photos')
  async photo(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @ProfileCommand() meta: ProfileCommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(RequestVenuePhotoBodySchema)) body: { content_type: string; byte_size: number },
  ) {
    return created(await this.profiles.requestPhoto(tx, actor, meta, venueId, body));
  }

  @Post('submit')
  @RequirePermission('venue.manage')
  @Command('POST /v1/venues/{venueId}/public-profile/submit')
  submit(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @ProfileCommand() meta: ProfileCommandMeta,
    @Param('venueId') venueId: string,
    @Body(input(SubmitVenuePublicProfileBodySchema)) body: { expected_version: number },
  ) {
    return this.profiles.submit(tx, actor, meta, venueId, body);
  }
}
