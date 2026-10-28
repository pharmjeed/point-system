import { CommandSession } from '@/api/command';
import { displayMessage, fallbackMessageAr, isApiError, isNetworkError } from '@/api/errors';
import { completeMedia, putToStorage, requestUpload, StorageError, type MediaRequest } from '@/api/field';
import type { Media, MediaKind } from '@/api/types';
import { compressPhoto, PHOTO_PROFILE, PHOTO_PROFILE_SMALL, PHOTO_TYPE, sha256Hex } from '@/lib/photos';
import { useIntakeStore } from '../intakeStore';

/**
 * One inspection photo, start to end (02 D-06, 07 §3.1): compress on the device → `POST /tickets/{id}/media`
 * (kind, type, exact byte size, sha256) → PUT the bytes to the presigned URL with the returned headers →
 * `POST /media/{id}/complete`. The tile follows in the intake store; the upload keeps running when the
 * driver leaves D-06 (the queue across reloads is PNT-071). Each API call is its own intent with its own
 * Idempotency-Key, resent with the same key after a network failure (CommandSession).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendPhoto(
  ticketId: string,
  kind: MediaKind,
  blob: Blob,
  capturedAt: string,
  onProgress: (p: number) => void,
): Promise<Media> {
  const sha256 = await sha256Hex(blob);
  const request: MediaRequest = {
    kind,
    content_type: PHOTO_TYPE,
    byte_size: blob.size,
    ...(sha256 ? { sha256 } : {}),
    captured_at: capturedAt,
  };
  const { media, upload } = await new CommandSession<MediaRequest>().run(request, (body, key) =>
    requestUpload(ticketId, body, key),
  );
  for (let attempt = 0; ; attempt += 1) {
    try {
      await putToStorage(upload, blob, onProgress);
    } catch (error) {
      if (isNetworkError(error) && attempt === 0) {
        await sleep(2000);
        continue;
      }
      throw error;
    }
    try {
      return await new CommandSession<{ sha256?: string }>().run(sha256 ? { sha256 } : {}, (body, key) =>
        completeMedia(media.id, body, key),
      );
    } catch (error) {
      // 02 D-06: MEDIA_UPLOAD_INCOMPLETE → upload the bytes again, then confirm (a new intent, new key)
      if (isApiError(error, 'MEDIA_UPLOAD_INCOMPLETE') && attempt === 0) continue;
      throw error;
    }
  }
}

export function startPhotoUpload(ticketId: string, slot: string, kind: MediaKind, file: File): void {
  const store = useIntakeStore.getState();
  store.putPhoto(ticketId, { slot, kind, state: 'uploading', progress: 0 });
  const patch = (p: Parameters<typeof store.patchPhoto>[2]) =>
    useIntakeStore.getState().patchPhoto(ticketId, slot, p);
  const capturedAt = new Date(file.lastModified || Date.now()).toISOString();

  void (async () => {
    let profile: { maxEdge: number; quality: number } = PHOTO_PROFILE;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let blob: Blob;
      try {
        blob = await compressPhoto(file, profile);
      } catch {
        // not an image the device can decode (02 D-06 MEDIA_TYPE_UNSUPPORTED: «التقط الصورة بالكاميرا»)
        patch({ state: 'failed', error: fallbackMessageAr('MEDIA_TYPE_UNSUPPORTED') });
        return;
      }
      try {
        const src = URL.createObjectURL(blob);
        useIntakeStore.getState().putPhoto(ticketId, { slot, kind, state: 'uploading', progress: 0, src });
        const media = await sendPhoto(ticketId, kind, blob, capturedAt, (progress) => patch({ progress }));
        patch({ state: 'uploaded', progress: 100, mediaId: media.id, error: undefined });
        return;
      } catch (error) {
        // 02 D-06: MEDIA_TOO_LARGE → stronger compression (1280 px, 0.7) once, then the 08 text
        if (isApiError(error, 'MEDIA_TOO_LARGE') && attempt === 0) {
          profile = PHOTO_PROFILE_SMALL;
          continue;
        }
        patch({
          state: 'failed',
          // the storage refused the bytes (expired URL, size) or the network dropped after the automatic
          // retry: the 08 text of an unfinished upload — the tile itself is the «إعادة المحاولة»
          error:
            error instanceof StorageError || isNetworkError(error)
              ? fallbackMessageAr('MEDIA_UPLOAD_INCOMPLETE')
              : displayMessage(error),
        });
        return;
      }
    }
  })();
}
