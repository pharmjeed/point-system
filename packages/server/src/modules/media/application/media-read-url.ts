import { Inject, Injectable } from '@nestjs/common';
import { OPEN_TASK_STATUSES } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Logger } from '../../../core/logging/logger.js';
import { CLOCK, DATABASE, ENV, LOGGER } from '../../../http/tokens.js';
import { canReadTicketPhotos, isUuid, readUrlTtlSeconds } from '../domain/media-policy.js';
import { findMediaWithTicket } from '../infra/media-queries.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../infra/object-storage.js';
import { PHOTO_CACHE_CONTROL } from './complete-media-upload.js';
import { mediaNotFound, uploadIncomplete } from './media-errors.js';

/** 07_openapi `SignedUrl` */
export interface SignedUrlDto {
  url: string;
  expires_at: string;
}

/**
 * `GET /v1/media/{mediaId}/url` (`ticket.read_photos`): a short-lived presigned GET (≤ 300 s, 09 §6.3) for
 * an actor allowed to see the ticket's photos; anyone else gets the media's not-found code, as if it did not
 * exist (08 §1.3 rule 4). The link itself is never stored or logged; its issuance is (09 §3).
 */
@Injectable()
export class MediaReadUrlQuery {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async execute(actor: ActorContext, mediaId: string, requestId: string): Promise<SignedUrlDto> {
    if (!isUuid(mediaId)) throw mediaNotFound();
    const m = await findMediaWithTicket(this.db, mediaId, actor.orgId, actor.userId, OPEN_TASK_STATUSES);
    if (
      !m ||
      !actor.venueIds.has(m.venue_id) ||
      !canReadTicketPhotos(actor, {
        createdBy: m.ticket_created_by,
        status: m.ticket_status,
        readerHasOpenTask: m.reader_has_open_task,
      })
    ) {
      throw mediaNotFound();
    }
    if (m.upload_status !== 'uploaded') throw uploadIncomplete(m.id, m.upload_status);

    const signed = await this.storage.presignDownload(m.storage_key, {
      expiresInS: readUrlTtlSeconds(this.env.MEDIA_READ_URL_TTL_S),
      now: this.clock.now(),
      contentType: m.content_type,
      cacheControl: PHOTO_CACHE_CONTROL,
    });
    this.logger.info(
      {
        request_id: requestId,
        user_id: actor.userId,
        venue_id: m.venue_id,
        ticket_id: m.ticket_id,
        media_id: m.id,
        expires_at: signed.expiresAt.toISOString(),
      },
      'media read url issued',
    );
    return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
  }
}
