import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import type * as S3 from '@aws-sdk/client-s3';
import type * as S3Presigner from '@aws-sdk/s3-request-presigner';
import type { Env } from '../../../core/config/env.js';
import { presignedExpiry } from '../domain/media-policy.js';
import {
  ObjectStorageError,
  type ObjectStorage,
  type PresignDownloadOptions,
  type PresignUploadOptions,
  type PresignedDownload,
  type PresignedUpload,
  type PutObjectOptions,
  type StoredObjectInfo,
} from './object-storage.js';

/**
 * The AWS SDK is loaded through Node's CommonJS resolution (its `dist-cjs` build), and only when an S3
 * storage is created. Its package exports list a bundler-only `module` build (extensionless ESM) first,
 * which a resolver honouring the `module` condition — the Vitest config does — would pick and fail on.
 */
const requireCjs = createRequire(import.meta.url);
let sdk: { s3: typeof S3; presigner: typeof S3Presigner } | null = null;
function loadSdk(): { s3: typeof S3; presigner: typeof S3Presigner } {
  sdk ??= {
    s3: requireCjs('@aws-sdk/client-s3') as typeof S3,
    presigner: requireCjs('@aws-sdk/s3-request-presigner') as typeof S3Presigner,
  };
  return sdk;
}

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  /** empty/undefined for AWS S3; `http://localhost:9000` for the local MinIO (05 §8) */
  endpoint?: string;
  /** MinIO needs path-style URLs (`S3_FORCE_PATH_STYLE`) */
  forcePathStyle: boolean;
  /** static credentials; omitted → the AWS default chain (environment, instance or task role) */
  accessKeyId?: string;
  secretAccessKey?: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

/**
 * S3 / MinIO implementation (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, 05 §4). Buckets are
 * private: objects are only reachable with a presigned URL or the server's credentials.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly bucket: string;
  readonly client: S3.S3Client;
  private readonly s3: typeof S3;
  private readonly presigner: typeof S3Presigner;

  constructor(readonly options: S3ObjectStorageOptions) {
    const { s3, presigner } = loadSdk();
    this.s3 = s3;
    this.presigner = presigner;
    this.bucket = options.bucket;
    this.client = new s3.S3Client({
      region: options.region,
      endpoint: options.endpoint || undefined,
      forcePathStyle: options.forcePathStyle,
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
      // No default CRC checksums: a presigned PUT must not carry a checksum of an empty body, and MinIO
      // versions differ in their support of the flexible-checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: options.maxAttempts ?? 2,
      requestHandler: {
        connectionTimeout: options.connectionTimeoutMs ?? 3000,
        requestTimeout: options.requestTimeoutMs ?? 15000,
      },
    });
  }

  static fromEnv(env: Env): S3ObjectStorage {
    return new S3ObjectStorage({
      bucket: env.S3_BUCKET_MEDIA,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
    });
  }

  async presignUpload(key: string, o: PresignUploadOptions): Promise<PresignedUpload> {
    const command = new this.s3.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: o.contentType,
      ContentLength: o.contentLength,
    });
    // content-type and content-length are signed: S3 rejects a PUT with another type or another length.
    const url = await this.presigner.getSignedUrl(this.client, command, {
      expiresIn: o.expiresInS,
      signingDate: o.now,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': o.contentType },
      expiresAt: presignedExpiry(o.now, o.expiresInS),
    };
  }

  async presignDownload(key: string, o: PresignDownloadOptions): Promise<PresignedDownload> {
    const command = new this.s3.GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: o.contentType,
      ResponseCacheControl: o.cacheControl,
    });
    const url = await this.presigner.getSignedUrl(this.client, command, {
      expiresIn: o.expiresInS,
      signingDate: o.now,
    });
    return { url, expiresAt: presignedExpiry(o.now, o.expiresInS) };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const r = await this.client.send(new this.s3.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw classifyS3Error(e, 'head');
    }
  }

  async get(key: string, opts: { maxBytes?: number } = {}): Promise<Buffer | null> {
    let r;
    try {
      r = await this.client.send(new this.s3.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw classifyS3Error(e, 'get');
    }
    const body = r.Body;
    if (!body) return Buffer.alloc(0);
    if (opts.maxBytes !== undefined && (r.ContentLength ?? 0) > opts.maxBytes) {
      (body as unknown as Readable).destroy?.();
      throw new ObjectStorageError('too_large', `object is larger than ${opts.maxBytes} bytes`);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await body.transformToByteArray());
    } catch (e) {
      throw classifyS3Error(e, 'get');
    }
    if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) {
      throw new ObjectStorageError('too_large', `object is larger than ${opts.maxBytes} bytes`);
    }
    return bytes;
  }

  async put(key: string, body: Buffer, o: PutObjectOptions): Promise<'created' | 'exists'> {
    try {
      await this.client.send(
        new this.s3.PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: o.contentType,
          CacheControl: o.cacheControl,
          IfNoneMatch: o.ifNoneMatch ? '*' : undefined,
        }),
      );
      return 'created';
    } catch (e) {
      if (o.ifNoneMatch && httpStatus(e) === 412) return 'exists';
      throw classifyS3Error(e, 'put');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new this.s3.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      if (isNotFound(e)) return;
      throw classifyS3Error(e, 'delete');
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

function httpStatus(e: unknown): number | undefined {
  return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  if (name === 'NoSuchBucket') return false;
  return name === 'NotFound' || name === 'NoSuchKey' || httpStatus(e) === 404;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const MISCONFIGURED = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'NoSuchBucket',
  'AuthorizationHeaderMalformed',
  'CredentialsProviderError',
  'PermanentRedirect',
]);

/** S3/network errors → the port's failure classes (the raw SDK error is kept as `cause`, never returned). */
export function classifyS3Error(e: unknown, op: string): ObjectStorageError {
  const err = e as { name?: string; code?: string };
  const status = httpStatus(e);
  const name = err?.name ?? '';
  const message = `object storage ${op} failed: ${name || err?.code || 'error'}${status ? ` (${status})` : ''}`;
  if (name === 'TimeoutError' || name === 'RequestTimeout' || name === 'AbortError') {
    return new ObjectStorageError('timeout', message, { cause: e });
  }
  if (err?.code && NETWORK_CODES.has(err.code))
    return new ObjectStorageError('timeout', message, { cause: e });
  if (MISCONFIGURED.has(name) || status === 403 || status === 301) {
    return new ObjectStorageError('misconfigured', message, { cause: e });
  }
  return new ObjectStorageError('unavailable', message, { cause: e });
}
