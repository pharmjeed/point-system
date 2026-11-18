import { Inject, Injectable } from '@nestjs/common';
import type { MediaContentType } from '@point/shared';
import type { Env } from '../../../core/config/env.js';
import { AppError } from '../../../core/errors/app-error.js';
import { ENV } from '../../../http/tokens.js';
import {
  ImageRejectedError,
  OBJECT_STORAGE,
  PHOTO_CACHE_CONTROL,
  assertSanitized,
  isSupportedContentType,
  mediaTooLarge,
  mediaTypeUnsupported,
  normalizeContentType,
  sanitizeImage,
  storageFailureToAppError,
  uploadIncomplete,
  type ObjectStorage,
} from '../../media/index.js';
import { photoStorageKey, photoUploadKey } from '../domain/profile-policy.js';

/**
 * Result of the storage phase of `PUT /v1/venues/{venueId}/public-profile`, computed before the command
 * transaction opens (no object-storage I/O inside a transaction, ENGINEERING §2, 04 §5.3 rule 5).
 * `verified` = the photo ids whose sanitized object is in the bucket; the command attaches nothing else.
 */
export type PhotoIngestPlan =
  { kind: 'error'; error: unknown } | { kind: 'ready'; verified: ReadonlySet<string> };

/**
 * The venue photos follow the inspection photos' pipeline (DEC-36, DEC-494): the client PUTs the original to its
 * presigned `incoming/` key; here the bytes are checked (size, declared type), decoded and re-encoded without any
 * metadata (`sanitizeImage`), written create-only to the final key, and the original deleted. A photo already
 * sanitized (attached before, or an interrupted attempt) is verified by its final object only.
 */
@Injectable()
export class VenuePhotoIngest {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Never throws: every outcome, error included, is returned as a plan answered by the command. */
  async prepare(orgId: string, venueId: string, photoIds: readonly string[]): Promise<PhotoIngestPlan> {
    try {
      const verified = new Set<string>();
      for (const id of photoIds) {
        await this.ingest(orgId, venueId, id.toLowerCase());
        verified.add(id.toLowerCase());
      }
      return { kind: 'ready', verified };
    } catch (e) {
      return { kind: 'error', error: storageFailureToAppError(e, this.env.MEDIA_MAX_BYTES) };
    }
  }

  private async ingest(orgId: string, venueId: string, photoId: string): Promise<void> {
    const finalKey = photoStorageKey(orgId, venueId, photoId);
    const uploadKey = photoUploadKey(orgId, venueId, photoId);
    const max = this.env.MEDIA_MAX_BYTES;
    const head = await this.storage.head(uploadKey);
    if (!head) {
      const existing = await this.storage.get(finalKey, { maxBytes: max });
      if (!existing) throw uploadIncomplete(photoId, 'pending');
      await assertSanitized(existing);
      return;
    }
    const reject = async (error: AppError): Promise<never> => {
      await this.storage.delete(uploadKey); // the unsanitized bytes are never kept (09 §6.2)
      throw error;
    };
    if (head.size > max) await reject(mediaTooLarge(max));
    const declared = normalizeContentType(head.contentType ?? '');
    if (!isSupportedContentType(declared)) await reject(mediaTypeUnsupported());
    const original = await this.storage.get(uploadKey, { maxBytes: max });
    if (!original) throw uploadIncomplete(photoId, 'pending');
    let clean;
    try {
      clean = await sanitizeImage(original, { declaredContentType: declared as MediaContentType });
    } catch (e) {
      if (e instanceof ImageRejectedError)
        return reject(e.reason === 'too_large' ? mediaTooLarge(max) : mediaTypeUnsupported());
      throw e;
    }
    if (clean.byteSize > max) await reject(mediaTooLarge(max));
    await this.storage.put(finalKey, clean.data, {
      contentType: clean.contentType,
      cacheControl: PHOTO_CACHE_CONTROL,
      ifNoneMatch: true, // a concurrent attempt that stored it first wins; both converge on one object
    });
    await this.storage.delete(uploadKey);
  }
}
