import { useEffect, useState } from 'react';
import { CommandSession, type CommandIntent } from '@/api/command';
import { displayMessage, fallbackMessageAr, isApiError, isNetworkError } from '@/api/errors';
import { completeMedia, putToStorage, requestUpload, StorageError, type MediaRequest } from '@/api/field';
import type { Media, MediaKind } from '@/api/types';
import { compressPhoto, PHOTO_PROFILE, PHOTO_PROFILE_SMALL, PHOTO_TYPE, sha256Hex } from '@/lib/photos';
import { forgetPhoto, hydrateIntake, savePhoto, updatePhoto, type PhotoRow } from '../intakePersistence';
import { useIntakeStore } from '../intakeStore';

/**
 * One inspection photo, start to end (02 D-06, 07 §3.1): compress on the device → `POST /tickets/{id}/media`
 * (kind, type, exact byte size, sha256) → PUT the bytes to the presigned URL with the returned headers →
 * `POST /media/{id}/complete`. The tile follows in the intake store and the upload keeps running when the
 * driver leaves D-06. The queue survives a reload (PNT-071): the compressed photo and the intent of its
 * media request stay in IndexedDB until the server confirmed it, and a reload resumes it with the same
 * Idempotency-Key (the server answers the same media row again). Each API call is its own intent, resent
 * with the same key after a network failure (CommandSession).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendPhoto(
  ticketId: string,
  kind: MediaKind,
  blob: Blob,
  capturedAt: string,
  onProgress: (p: number) => void,
  request: CommandSession<MediaRequest>,
): Promise<Media> {
  const sha256 = await sha256Hex(blob);
  const body: MediaRequest = {
    kind,
    content_type: PHOTO_TYPE,
    byte_size: blob.size,
    ...(sha256 ? { sha256 } : {}),
    captured_at: capturedAt,
  };
  const { media, upload } = await request.run(body, (b, key) => requestUpload(ticketId, b, key));
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
      return await new CommandSession<{ sha256?: string }>().run(sha256 ? { sha256 } : {}, (b, key) =>
        completeMedia(media.id, b, key),
      );
    } catch (error) {
      // 02 D-06: MEDIA_UPLOAD_INCOMPLETE → upload the bytes again, then confirm (a new intent, new key)
      if (isApiError(error, 'MEDIA_UPLOAD_INCOMPLETE') && attempt === 0) continue;
      throw error;
    }
  }
}

type Outcome = 'uploaded' | 'too_large' | 'failed';

/**
 * Uploads a compressed photo for a tile, keeping it in IndexedDB until the server confirmed it. `intent` is
 * the saved media request of a resumed upload.
 */
async function uploadCompressed(
  ticketId: string,
  slot: string,
  kind: MediaKind,
  blob: Blob,
  capturedAt: string,
  intent: CommandIntent | null,
): Promise<Outcome> {
  const store = useIntakeStore.getState();
  const patch = (p: Parameters<typeof store.patchPhoto>[2]) =>
    useIntakeStore.getState().patchPhoto(ticketId, slot, p);
  const current = store.drafts[ticketId]?.photos[slot];
  const src = current?.src ?? URL.createObjectURL(blob);
  store.putPhoto(ticketId, { slot, kind, state: 'uploading', progress: 0, src });
  await savePhoto(ticketId, { slot, kind, blob, capturedAt, state: 'uploading', retriable: true, intent });
  const request = new CommandSession<MediaRequest>({
    onIntent: (next) => void updatePhoto(ticketId, slot, { intent: next }),
  });
  request.restore(intent);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const media = await sendPhoto(
        ticketId,
        kind,
        blob,
        capturedAt,
        (progress) => patch({ progress }),
        request,
      );
      patch({ state: 'uploaded', progress: 100, mediaId: media.id, error: undefined });
      await forgetPhoto(ticketId, slot);
      return 'uploaded';
    } catch (error) {
      // a resumed request whose presigned URL is no longer accepted: ask for a new one (a new intent)
      if (error instanceof StorageError && intent && attempt === 0) {
        request.reset();
        continue;
      }
      if (isApiError(error, 'MEDIA_TOO_LARGE')) return 'too_large';
      // the storage refused the bytes (expired URL, size) or the network dropped after the automatic
      // retry: the 08 text of an unfinished upload — the tile itself is the «إعادة المحاولة»
      const retriable = error instanceof StorageError || isNetworkError(error);
      const text = retriable ? fallbackMessageAr('MEDIA_UPLOAD_INCOMPLETE') : displayMessage(error);
      patch({ state: 'failed', error: text });
      await updatePhoto(ticketId, slot, { state: 'failed', error: text, retriable });
      return 'failed';
    }
  }
}

export function startPhotoUpload(ticketId: string, slot: string, kind: MediaKind, file: File): void {
  const store = useIntakeStore.getState();
  store.putPhoto(ticketId, { slot, kind, state: 'uploading', progress: 0 });
  const capturedAt = new Date(file.lastModified || Date.now()).toISOString();

  void (async () => {
    let profile: { maxEdge: number; quality: number } = PHOTO_PROFILE;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let blob: Blob;
      try {
        blob = await compressPhoto(file, profile);
      } catch {
        // not an image the device can decode (02 D-06 MEDIA_TYPE_UNSUPPORTED: «التقط الصورة بالكاميرا»)
        useIntakeStore.getState().patchPhoto(ticketId, slot, {
          state: 'failed',
          error: fallbackMessageAr('MEDIA_TYPE_UNSUPPORTED'),
        });
        return;
      }
      // a retake replaces the tile's photo (02 D-06): its own object URL
      const previous = useIntakeStore.getState().drafts[ticketId]?.photos[slot];
      if (previous?.src) URL.revokeObjectURL(previous.src);
      useIntakeStore.getState().putPhoto(ticketId, {
        slot,
        kind,
        state: 'uploading',
        progress: 0,
        src: URL.createObjectURL(blob),
      });
      const outcome = await uploadCompressed(ticketId, slot, kind, blob, capturedAt, null);
      // 02 D-06: MEDIA_TOO_LARGE → stronger compression (1280 px, 0.7) once, then the 08 text
      if (outcome === 'too_large' && attempt === 0) {
        profile = PHOTO_PROFILE_SMALL;
        continue;
      }
      if (outcome === 'too_large') await tooLarge(ticketId, slot);
      return;
    }
  })();
}

/** Still too large after the stronger compression: the 08 text; not resumed after a reload. */
async function tooLarge(ticketId: string, slot: string): Promise<void> {
  const text = fallbackMessageAr('MEDIA_TOO_LARGE');
  useIntakeStore.getState().patchPhoto(ticketId, slot, { state: 'failed', error: text });
  await updatePhoto(ticketId, slot, { state: 'failed', error: text, retriable: false });
}

/** A photo saved before the reload: uploading, or failed on the network — it goes on by itself. */
function resumePhoto(ticketId: string, row: PhotoRow): void {
  if (row.state === 'failed' && !row.retriable) return;
  void uploadCompressed(ticketId, row.slot, row.kind, row.blob, row.capturedAt, row.intent).then((outcome) =>
    outcome === 'too_large' ? tooLarge(ticketId, row.slot) : undefined,
  );
}

/**
 * The intake screens wait for the saved draft of their ticket before showing the form (PNT-071), then the
 * pending photos resume. `ready` is true at once when IndexedDB is unavailable or the draft is in memory.
 */
export function useIntakeHydration(userId: string, ticketId: string): boolean {
  const key = `${userId}:${ticketId}`;
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void hydrateIntake(userId, ticketId).then(
      (photos) => {
        for (const row of photos) resumePhoto(ticketId, row);
        if (active) setReady(key);
      },
      () => {
        if (active) setReady(key);
      },
    );
    return () => {
      active = false;
    };
  }, [userId, ticketId, key]);
  return ready === key;
}
