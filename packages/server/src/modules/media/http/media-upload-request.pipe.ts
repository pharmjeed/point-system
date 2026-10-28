import { Inject, Injectable, type PipeTransform } from '@nestjs/common';
import { MediaKindSchema } from '@point/shared';
import { z } from 'zod';
import type { Env } from '../../../core/config/env.js';
import { AppError } from '../../../core/errors/app-error.js';
import { ENV } from '../../../http/tokens.js';
import { zodToFields } from '../../../http/zod-pipe.js';
import { mediaTooLarge, mediaTypeUnsupported } from '../application/media-errors.js';
import type { MediaUploadRequest } from '../application/request-media-upload.js';
import { isSupportedContentType, normalizeContentType } from '../domain/media-policy.js';

const UploadRequestShape = z.strictObject({
  kind: MediaKindSchema,
  // checked below against media_assets.content_type → MEDIA_TYPE_UNSUPPORTED (08 §4.14), not VALIDATION_FAILED
  content_type: z.string().min(1).max(255),
  // the upper bound is MEDIA_MAX_BYTES → MEDIA_TOO_LARGE
  byte_size: z.number().int().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  captured_at: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Input shape of `POST /v1/tickets/{ticketId}/media` (08 §2 step 6): VALIDATION_FAILED for the shape,
 * then MEDIA_TYPE_UNSUPPORTED (`allowed_types`) and MEDIA_TOO_LARGE (`max_bytes`, MEDIA_MAX_BYTES).
 */
@Injectable()
export class MediaUploadRequestPipe implements PipeTransform<unknown, MediaUploadRequest> {
  constructor(@Inject(ENV) private readonly env: Env) {}

  transform(value: unknown): MediaUploadRequest {
    const r = UploadRequestShape.safeParse(value ?? {});
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    const contentType = normalizeContentType(r.data.content_type);
    if (!isSupportedContentType(contentType)) throw mediaTypeUnsupported();
    if (r.data.byte_size > this.env.MEDIA_MAX_BYTES) throw mediaTooLarge(this.env.MEDIA_MAX_BYTES);
    return {
      kind: r.data.kind,
      content_type: contentType,
      byte_size: r.data.byte_size,
      ...(r.data.sha256 ? { sha256: r.data.sha256 } : {}),
      ...(r.data.captured_at ? { captured_at: r.data.captured_at } : {}),
    };
  }
}
