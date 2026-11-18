import { PHOTO_CACHE_CONTROL, readUrlTtlSeconds } from '../../media/index.js';
import type { ObjectStorage } from '../../media/index.js';
import { photoStorageKey } from '../domain/profile-policy.js';

/** One photo of a public profile as served: a short-lived presigned GET of the private bucket (≤ 300 s, 09 §6.3). */
export interface ProfilePhotoDto {
  id: string;
  url: string;
  expires_at: string;
}

export interface PhotoSigner {
  storage: ObjectStorage;
  /** signing time (the request's clock) */
  now: Date;
  /** MEDIA_READ_URL_TTL_S; capped at 300 s */
  ttlS: number;
}

/**
 * Presigns every photo of a profile. Never a public bucket URL: the bucket stays private and each link expires
 * (DEC-494). Presigning is local math, so it may run anywhere, transactions included.
 */
export async function signProfilePhotos(
  signer: PhotoSigner,
  orgId: string,
  venueId: string,
  photoIds: readonly string[],
): Promise<ProfilePhotoDto[]> {
  const expiresInS = readUrlTtlSeconds(signer.ttlS);
  return Promise.all(
    photoIds.map(async (id) => {
      const signed = await signer.storage.presignDownload(photoStorageKey(orgId, venueId, id), {
        expiresInS,
        now: signer.now,
        cacheControl: PHOTO_CACHE_CONTROL,
      });
      return { id, url: signed.url, expires_at: signed.expiresAt.toISOString() };
    }),
  );
}
