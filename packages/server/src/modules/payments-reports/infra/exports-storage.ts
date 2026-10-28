import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Logger } from '../../../core/logging/logger.js';
import {
  InMemoryObjectStorage,
  S3ObjectStorage,
  selectObjectStorageDriver,
  type ObjectStorage,
} from '../../media/index.js';

/**
 * The private exports bucket (`S3_BUCKET_EXPORTS`, 05 §8; DEC-128: no versioning). It is a second instance of
 * the media module's ObjectStorage implementations — the same driver selection (S3/MinIO, or the in-memory
 * private bucket for local runs and tests without S3), only the bucket differs — so there is one S3 client
 * implementation in the code base.
 */
export const EXPORTS_STORAGE = Symbol('EXPORTS_STORAGE');

export function createExportsStorage(env: Env, clock: Clock, logger?: Logger): ObjectStorage {
  if (selectObjectStorageDriver(env) === 's3') {
    return new S3ObjectStorage({
      bucket: env.S3_BUCKET_EXPORTS,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
    });
  }
  if (env.APP_ENV === 'local') {
    logger?.warn(
      { bucket: env.S3_BUCKET_EXPORTS },
      'S3_ENDPOINT is not configured: export files are kept in memory and lost on restart',
    );
  }
  return new InMemoryObjectStorage({ clock, bucket: env.S3_BUCKET_EXPORTS });
}

/** Storage key of an export file: unguessable (the export id) and grouped per organization. */
export const exportStorageKey = (orgId: string, exportId: string) => `exports/${orgId}/${exportId}.csv`;

export const EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8';

let registered: ObjectStorage | null = null;

/** The process's exports storage for `job.export_generate` (registered by the api module and the worker). */
export function registerExportsStorage(storage: ObjectStorage | null): void {
  registered = storage;
}

export function registeredExportsStorage(): ObjectStorage | null {
  return registered;
}
