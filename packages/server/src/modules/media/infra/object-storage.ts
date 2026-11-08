/**
 * Object storage port (05 §4, 09 §6): private buckets, short-lived presigned URLs, no public access.
 *
 * Presigning is local computation (HMAC over the request) and may run inside a database transaction
 * (ENGINEERING §2, 04 §5.3 rule 5). Every other method is network I/O and must never run inside a
 * transaction.
 */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export type ObjectStorageDriver = 's3' | 'memory';

/** What the client needs to upload directly to the private bucket (07 `UploadInstruction`). */
export interface PresignedUpload {
  method: 'PUT';
  url: string;
  /** headers the client must send verbatim (they are part of the signature) */
  headers: Record<string, string>;
  expiresAt: Date;
}

/** A short-lived read link (07 `SignedUrl`). */
export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  size: number;
  contentType: string | null;
}

export interface PresignUploadOptions {
  contentType: string;
  /** exact body size: signed, so the storage rejects a body of another length */
  contentLength: number;
  expiresInS: number;
  /** signing time (the transaction's `now`) */
  now: Date;
}

export interface PresignDownloadOptions {
  expiresInS: number;
  now: Date;
  /** response-content-type override */
  contentType?: string;
  /** response-cache-control override (09 §6.3: private, no-store) */
  cacheControl?: string;
}

export interface PutObjectOptions {
  contentType: string;
  cacheControl?: string;
  /** create only (`If-None-Match: *`): an existing object is left untouched and 'exists' is returned */
  ifNoneMatch?: boolean;
}

export type ObjectStorageFailure =
  /** no answer in time, connection refused/reset, DNS failure */
  | 'timeout'
  /** the storage answered with a server error (5xx, slow down, conflicting conditional write) */
  | 'unavailable'
  /** the object is larger than the caller's limit */
  | 'too_large'
  /** credentials, bucket or signature problems: an operator must fix the configuration */
  | 'misconfigured';

export class ObjectStorageError extends Error {
  constructor(
    readonly failure: ObjectStorageFailure,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ObjectStorageError';
  }
}

export interface ObjectStorage {
  readonly driver: ObjectStorageDriver;
  readonly bucket: string;

  /** Presigned PUT bound to the content type and the exact length (local math, allowed inside a tx). */
  presignUpload(key: string, opts: PresignUploadOptions): Promise<PresignedUpload>;
  /** Presigned GET (local math, allowed inside a tx). */
  presignDownload(key: string, opts: PresignDownloadOptions): Promise<PresignedDownload>;

  /** null when the object does not exist. */
  head(key: string): Promise<StoredObjectInfo | null>;
  /** null when the object does not exist; ObjectStorageError('too_large') above `maxBytes`. */
  get(key: string, opts?: { maxBytes?: number }): Promise<Buffer | null>;
  put(key: string, body: Buffer, opts: PutObjectOptions): Promise<'created' | 'exists'>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;

  close?(): Promise<void>;
}
