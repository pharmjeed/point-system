import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Logger } from '../../../core/logging/logger.js';
import { CLOCK, ENV, LOGGER } from '../../../http/tokens.js';
import { CompleteMediaUploadUseCase } from '../application/complete-media-upload.js';
import { MediaReadUrlQuery } from '../application/media-read-url.js';
import { RequestMediaUploadUseCase } from '../application/request-media-upload.js';
import { createObjectStorage } from '../infra/object-storage.factory.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../infra/object-storage.js';
import { MediaCompletionPreparer } from './media-completion.preparer.js';
import { MediaController } from './media.controller.js';
import { MediaUploadRequestPipe } from './media-upload-request.pipe.js';

/**
 * Inspection photos (PNT-027): `POST /v1/tickets/{ticketId}/media`, `POST /v1/media/{mediaId}/complete`,
 * `GET /v1/media/{mediaId}/url`. The object storage is chosen from the environment (S3/MinIO, or the
 * in-memory bucket for tests and local runs without S3) and exported as OBJECT_STORAGE.
 */
@Module({
  controllers: [MediaController],
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ENV, CLOCK, LOGGER],
      useFactory: (env: Env, clock: Clock, logger: Logger) => createObjectStorage(env, clock, logger),
    },
    RequestMediaUploadUseCase,
    CompleteMediaUploadUseCase,
    MediaReadUrlQuery,
    MediaCompletionPreparer,
    MediaUploadRequestPipe,
  ],
  exports: [OBJECT_STORAGE],
})
export class MediaHttpModule implements OnModuleDestroy {
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  async onModuleDestroy(): Promise<void> {
    await this.storage.close?.();
  }
}
