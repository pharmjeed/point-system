import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Clock } from '../../../core/clock/clock.js';
import { safeEqual } from '../../../core/crypto/crypto.js';
import { presignedExpiry } from '../domain/media-policy.js';
import {
  ObjectStorageError,
  type ObjectStorage,
  type ObjectStorageFailure,
  type PresignDownloadOptions,
  type PresignUploadOptions,
  type PresignedDownload,
  type PresignedUpload,
  type PutObjectOptions,
  type StoredObjectInfo,
} from './object-storage.js';

export type InMemoryStorageOperation = 'head' | 'get' | 'put' | 'delete';

export interface InMemoryObjectStorageOptions {
  /** expiry of the simulated presigned URLs follows this clock (FakeClock in tests) */
  clock: Clock;
  bucket?: string;
  /** origin of the simulated presigned URLs */
  baseUrl?: string;
  /** HMAC key of the simulated signatures (random per instance by default) */
  signingKey?: Buffer;
}

/** The answer S3 would give to an HTTP request on a (presigned) URL. */
export interface SimulatedHttpResponse {
  status: number;
  /** S3 error code for 4xx answers: AccessDenied, SignatureDoesNotMatch, NoSuchKey… */
  code?: string;
  message?: string;
  body?: Buffer;
  headers: Record<string, string>;
}

export interface StoredObject {
  body: Buffer;
  contentType: string;
  cacheControl: string | null;
}

const PARAM = {
  method: 'X-Mem-Method',
  date: 'X-Mem-Date',
  expires: 'X-Mem-Expires',
  contentType: 'X-Mem-Content-Type',
  contentLength: 'X-Mem-Content-Length',
  responseContentType: 'response-content-type',
  responseCacheControl: 'response-cache-control',
  signature: 'X-Mem-Signature',
} as const;

/**
 * Object storage for tests and for local runs without S3 configuration. It behaves like a private S3 bucket:
 * presigned URLs carry an HMAC over the method, the key, the expiry and the signed headers; a request
 * without a valid, unexpired signature is refused with 403 (there is no anonymous access). `handleHttp`,
 * `upload` and `download` simulate what a browser does with the URLs, without any network.
 */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly driver = 'memory' as const;
  readonly bucket: string;
  readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly signingKey: Buffer;
  private readonly objects = new Map<string, StoredObject>();
  private readonly faults: { op: InMemoryStorageOperation | '*'; failure: ObjectStorageFailure }[] = [];
  /** every head/get/put/delete call, in order (presigning is not I/O and is not recorded) */
  readonly operations: { op: InMemoryStorageOperation; key: string }[] = [];
  /** test hook awaited before every head/get/put/delete (e.g. to assert that no transaction is open) */
  beforeOperation: ((op: InMemoryStorageOperation, key: string) => Promise<void> | void) | null = null;

  constructor(opts: InMemoryObjectStorageOptions) {
    this.clock = opts.clock;
    this.bucket = opts.bucket ?? 'point-media';
    this.baseUrl = (opts.baseUrl ?? 'http://object-storage.invalid').replace(/\/+$/, '');
    this.signingKey = opts.signingKey ?? randomBytes(32);
  }

  // ----- ObjectStorage ------------------------------------------------------------------------------

  async presignUpload(key: string, o: PresignUploadOptions): Promise<PresignedUpload> {
    const expiresAt = presignedExpiry(o.now, o.expiresInS);
    const url = this.sign('PUT', key, o.now, o.expiresInS, {
      [PARAM.contentType]: o.contentType,
      [PARAM.contentLength]: String(o.contentLength),
    });
    return { method: 'PUT', url, headers: { 'Content-Type': o.contentType }, expiresAt };
  }

  async presignDownload(key: string, o: PresignDownloadOptions): Promise<PresignedDownload> {
    const extra: Record<string, string> = {};
    if (o.contentType) extra[PARAM.responseContentType] = o.contentType;
    if (o.cacheControl) extra[PARAM.responseCacheControl] = o.cacheControl;
    return {
      url: this.sign('GET', key, o.now, o.expiresInS, extra),
      expiresAt: presignedExpiry(o.now, o.expiresInS),
    };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    await this.io('head', key);
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }

  async get(key: string, opts: { maxBytes?: number } = {}): Promise<Buffer | null> {
    await this.io('get', key);
    const o = this.objects.get(key);
    if (!o) return null;
    if (opts.maxBytes !== undefined && o.body.length > opts.maxBytes) {
      throw new ObjectStorageError('too_large', `object is larger than ${opts.maxBytes} bytes`);
    }
    return Buffer.from(o.body);
  }

  async put(key: string, body: Buffer, o: PutObjectOptions): Promise<'created' | 'exists'> {
    await this.io('put', key);
    if (o.ifNoneMatch && this.objects.has(key)) return 'exists';
    this.objects.set(key, {
      body: Buffer.from(body),
      contentType: o.contentType,
      cacheControl: o.cacheControl ?? null,
    });
    return 'created';
  }

  async delete(key: string): Promise<void> {
    await this.io('delete', key);
    this.objects.delete(key);
  }

  // ----- browser simulation -------------------------------------------------------------------------

  /** What the bucket answers to `method url` with these headers and body (the presigned URL is verified). */
  handleHttp(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    url: string,
    req: { headers?: Record<string, string>; body?: Buffer } = {},
  ): SimulatedHttpResponse {
    const prefix = `/${this.bucket}/`;
    let u: URL;
    let key: string;
    try {
      u = new URL(url);
      key = u.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    } catch {
      return deny(400, 'InvalidURI', 'malformed URL');
    }
    if (u.origin !== new URL(this.baseUrl).origin || !u.pathname.startsWith(prefix)) {
      return deny(404, 'NoSuchBucket', 'the bucket does not exist');
    }
    const signature = u.searchParams.get(PARAM.signature);
    // private bucket: no signature means no access, whatever the method
    if (!signature) return deny(403, 'AccessDenied', 'anonymous access is not allowed');
    const signedMethod = u.searchParams.get(PARAM.method) ?? '';
    const date = Number(u.searchParams.get(PARAM.date));
    const expires = Number(u.searchParams.get(PARAM.expires));
    const params = Object.fromEntries([...u.searchParams.entries()].filter(([k]) => k !== PARAM.signature));
    if (!safeEqual(this.signature(signedMethod, key, params), signature) || signedMethod !== method) {
      return deny(403, 'SignatureDoesNotMatch', 'the request signature does not match');
    }
    if (
      !Number.isFinite(date) ||
      !Number.isFinite(expires) ||
      this.clock.now().getTime() >= (date + expires) * 1000
    ) {
      return deny(403, 'AccessDenied', 'Request has expired');
    }
    const headers = lowerKeys(req.headers ?? {});
    if (method === 'PUT') {
      const body = req.body ?? Buffer.alloc(0);
      const signedType = u.searchParams.get(PARAM.contentType);
      const signedLength = u.searchParams.get(PARAM.contentLength);
      if (signedType !== null && (headers['content-type'] ?? '').trim() !== signedType) {
        return deny(403, 'SignatureDoesNotMatch', 'content-type differs from the signed value');
      }
      // a browser derives Content-Length from the body: another size changes a signed header
      if (signedLength !== null && String(body.length) !== signedLength) {
        return deny(403, 'SignatureDoesNotMatch', 'content-length differs from the signed value');
      }
      this.objects.set(key, {
        body: Buffer.from(body),
        contentType: signedType ?? 'application/octet-stream',
        cacheControl: null,
      });
      return {
        status: 200,
        headers: { etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` },
      };
    }
    if (method === 'GET' || method === 'HEAD') {
      const o = this.objects.get(key);
      if (!o) return deny(404, 'NoSuchKey', 'the object does not exist');
      const out: Record<string, string> = {
        'content-type': u.searchParams.get(PARAM.responseContentType) ?? o.contentType,
        'content-length': String(o.body.length),
      };
      const cc = u.searchParams.get(PARAM.responseCacheControl) ?? o.cacheControl;
      if (cc) out['cache-control'] = cc;
      return method === 'GET'
        ? { status: 200, headers: out, body: Buffer.from(o.body) }
        : { status: 200, headers: out };
    }
    return deny(405, 'MethodNotAllowed', 'method not allowed');
  }

  /** PUT `body` to an upload instruction the way the web app does (headers verbatim, overridable). */
  upload(
    instruction: { url: string; headers: Record<string, string> },
    body: Buffer,
    headerOverrides: Record<string, string> = {},
  ): SimulatedHttpResponse {
    return this.handleHttp('PUT', instruction.url, {
      headers: { ...instruction.headers, ...headerOverrides },
      body,
    });
  }

  download(url: string): SimulatedHttpResponse {
    return this.handleHttp('GET', url);
  }

  // ----- inspection & fault injection ---------------------------------------------------------------

  /** The next `times` calls of `op` (or of any operation) fail with this failure class. */
  failNext(op: InMemoryStorageOperation | '*', failure: ObjectStorageFailure = 'timeout', times = 1): void {
    for (let i = 0; i < times; i++) this.faults.push({ op, failure });
  }

  peek(key: string): StoredObject | undefined {
    const o = this.objects.get(key);
    return o ? { ...o, body: Buffer.from(o.body) } : undefined;
  }

  /** Writes an object directly (simulates a client that bypassed the presigned URL rules). */
  plant(key: string, body: Buffer, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { body: Buffer.from(body), contentType, cacheControl: null });
  }

  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  clear(): void {
    this.objects.clear();
    this.faults.length = 0;
    this.operations.length = 0;
  }

  // ----- internals ----------------------------------------------------------------------------------

  private async io(op: InMemoryStorageOperation, key: string): Promise<void> {
    this.operations.push({ op, key });
    await this.beforeOperation?.(op, key);
    const i = this.faults.findIndex((f) => f.op === op || f.op === '*');
    if (i >= 0) {
      const [f] = this.faults.splice(i, 1);
      throw new ObjectStorageError(f!.failure, `simulated ${f!.failure} on ${op}`);
    }
  }

  private sign(
    method: string,
    key: string,
    now: Date,
    expiresInS: number,
    extra: Record<string, string>,
  ): string {
    const params: Record<string, string> = {
      [PARAM.method]: method,
      [PARAM.date]: String(Math.floor(now.getTime() / 1000)),
      [PARAM.expires]: String(expiresInS),
      ...extra,
    };
    const q = new URLSearchParams(params);
    q.set(PARAM.signature, this.signature(method, key, params));
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/${this.bucket}/${path}?${q.toString()}`;
  }

  private signature(method: string, key: string, params: Record<string, string>): string {
    const canonical = Object.keys(params)
      .filter((k) => k !== PARAM.signature)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return createHmac('sha256', this.signingKey)
      .update(`${method}\n${this.bucket}\n${key}\n${canonical}`)
      .digest('hex');
  }
}

function deny(status: number, code: string, message: string): SimulatedHttpResponse {
  return { status, code, message, headers: {} };
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}
