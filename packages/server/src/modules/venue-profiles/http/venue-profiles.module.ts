import { Module } from '@nestjs/common';
import type { Env } from '../../../core/config/env.js';
import { ENV } from '../../../http/tokens.js';
import { MediaHttpModule } from '../../media/index.js';
import { ListCursorCodec } from '../../venues-events/index.js';
import { OperatorProfileService } from '../application/operator-profile.service.js';
import { VenuePhotoIngest } from '../application/photo-ingest.js';
import { PlatformReviewService } from '../application/platform-review.service.js';
import { OperatorProfileController } from './operator-profile.controller.js';
import { PhotoIngestPreparer } from './photo-ingest.preparer.js';
import { PlatformVenuesController } from './platform-venues.controller.js';

/**
 * V2-004 — the venue public profile: the operator's side (O-04, S-13, `/v1/venues/{venueId}/public-profile…`) and
 * the platform's review (P-04, `/v1/platform/venues…`). The photos live in the private bucket of MediaHttpModule.
 */
@Module({
  imports: [MediaHttpModule],
  controllers: [OperatorProfileController, PlatformVenuesController],
  providers: [
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
    OperatorProfileService,
    PlatformReviewService,
    VenuePhotoIngest,
    PhotoIngestPreparer,
  ],
})
export class VenueProfilesHttpModule {}
