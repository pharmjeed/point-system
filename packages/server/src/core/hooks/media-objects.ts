/**
 * Seam between job.retention_purge (audit-monitoring) and the modules that own the object-storage clients
 * (media for inspection photos, payments-reports for export files). The retention job never talks to S3
 * itself (04 §4.3: audit-monitoring imports core only); each owner registers a deleter for its bucket at
 * startup in the processes that run the job (the worker; the api registers too).
 *
 * Called OUTSIDE any database transaction (no network inside a transaction, canon §2). The retention job
 * deletes the objects first and then marks the rows (`media_assets.upload_status = 'deleted'`,
 * `exports.status = 'expired'`) in a short transaction for the keys reported as deleted; failed keys are
 * retried by the next run (06 §8.3).
 */
export type StorageBucketKind = 'media' | 'exports';

export interface ObjectDeleteResult {
  /** keys deleted, or already absent (deleting a missing key is a success) */
  deleted: string[];
  /** keys that could not be deleted now; the caller retries them later */
  failed: { key: string; error: string }[];
}

export type MediaObjectDeleter = (keys: readonly string[]) => Promise<ObjectDeleteResult>;

const deleters = new Map<StorageBucketKind, MediaObjectDeleter>();

/** Registers the deleter of a bucket (one per bucket and process); `null` unregisters it (tests, shutdown). */
export function registerMediaObjectDeleter(
  fn: MediaObjectDeleter | null,
  bucket: StorageBucketKind = 'media',
): void {
  if (fn) deleters.set(bucket, fn);
  else deleters.delete(bucket);
}

export function hasMediaObjectDeleter(bucket: StorageBucketKind = 'media'): boolean {
  return deleters.has(bucket);
}

/**
 * Deletes storage objects through the registered deleter. Throws when none is registered: callers check
 * `hasMediaObjectDeleter()` first and skip (and audit) the step instead of silently marking rows deleted.
 */
export async function deleteMediaObjects(
  keys: readonly string[],
  bucket: StorageBucketKind = 'media',
): Promise<ObjectDeleteResult> {
  if (keys.length === 0) return { deleted: [], failed: [] };
  const fn = deleters.get(bucket);
  if (!fn) throw new Error(`no object deleter is registered for the ${bucket} bucket`);
  const r = await fn(keys);
  // never report a key the caller did not ask for
  const asked = new Set(keys);
  return {
    deleted: r.deleted.filter((k) => asked.has(k)),
    failed: r.failed.filter((f) => asked.has(f.key)),
  };
}

/**
 * Adapts any storage with an idempotent `delete(key)` (the media module's ObjectStorage port) to a deleter:
 * keys are deleted with bounded concurrency and each failure is reported, never thrown.
 */
export function deleterForStore(
  store: { delete(key: string): Promise<void> },
  concurrency = 8,
): MediaObjectDeleter {
  return async (keys) => {
    const deleted: string[] = [];
    const failed: { key: string; error: string }[] = [];
    let next = 0;
    const worker = async () => {
      while (next < keys.length) {
        const key = keys[next++]!;
        try {
          await store.delete(key);
          deleted.push(key);
        } catch (e) {
          failed.push({ key, error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'error' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, keys.length)) }, worker));
    return { deleted, failed };
  };
}
