import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Logger } from '../../../core/logging/logger.js';
import { InMemoryObjectStorage } from './in-memory-object-storage.js';
import type { ObjectStorage, ObjectStorageDriver } from './object-storage.js';
import { S3ObjectStorage } from './s3-object-storage.js';

/**
 * S3 when an endpoint or static credentials are configured, and always in staging/production (where the AWS
 * default credential chain — instance or task role — may supply the credentials). Only local and test runs
 * without any S3 configuration use the in-memory bucket; tests rely on that.
 */
export function selectObjectStorageDriver(env: Env): ObjectStorageDriver {
  if (env.S3_ENDPOINT || (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) return 's3';
  if (env.APP_ENV === 'staging' || env.APP_ENV === 'production') return 's3';
  return 'memory';
}

export function createObjectStorage(env: Env, clock: Clock, logger?: Logger): ObjectStorage {
  if (selectObjectStorageDriver(env) === 's3') return S3ObjectStorage.fromEnv(env);
  if (env.APP_ENV === 'local') {
    logger?.warn(
      { bucket: env.S3_BUCKET_MEDIA },
      'S3_ENDPOINT is not configured: inspection photos are kept in memory and lost on restart',
    );
  }
  return new InMemoryObjectStorage({ clock, bucket: env.S3_BUCKET_MEDIA });
}
