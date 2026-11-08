import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock/clock.js';
import { loadEnv } from '../src/core/config/env.js';
import {
  InMemoryObjectStorage,
  ObjectStorageError,
  S3ObjectStorage,
  createObjectStorage,
  selectObjectStorageDriver,
} from '../src/modules/media/index.js';
import { classifyS3Error } from '../src/modules/media/infra/s3-object-storage.js';

const b64 = (s: string) => Buffer.from(s.padEnd(32, '.')).toString('base64');
const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    APP_BASE_URL: 'http://localhost:5173',
    BRAND_STAFF_NAME_AR: 'S',
    BRAND_STAFF_NAME_EN: 'S',
    BRAND_CUSTOMER_NAME_AR: 'C',
    BRAND_CUSTOMER_NAME_EN: 'C',
    DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none',
    SESSION_SECRET: b64('a'),
    CODE_PEPPER: b64('b'),
    AUTH_SECRET_PEPPER: b64('c'),
    DATA_ENCRYPTION_KEY: b64('d'),
    ...extra,
  });

describe('InMemoryObjectStorage — a private bucket with simulated presigned URLs', () => {
  const setup = () => {
    const clock = new FakeClock('2026-10-28T10:00:00.400Z');
    return { clock, storage: new InMemoryObjectStorage({ clock }) };
  };
  const body = Buffer.from('0123456789');

  it('a presigned PUT stores the body when the signed headers match, then a presigned GET returns it', async () => {
    const { clock, storage } = setup();
    const up = await storage.presignUpload('incoming/o/t/m-1', {
      contentType: 'image/jpeg',
      contentLength: body.length,
      expiresInS: 300,
      now: clock.now(),
    });
    expect(up).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    // signing time has a one-second resolution, like X-Amz-Date
    expect(up.expiresAt.toISOString()).toBe('2026-10-28T10:05:00.000Z');
    expect(storage.upload(up, body).status).toBe(200);
    expect(await storage.head('incoming/o/t/m-1')).toEqual({ size: 10, contentType: 'image/jpeg' });

    const down = await storage.presignDownload('incoming/o/t/m-1', {
      expiresInS: 60,
      now: clock.now(),
      contentType: 'image/jpeg',
      cacheControl: 'private, no-store',
    });
    const r = storage.download(down.url);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(body);
    expect(r.headers).toMatchObject({ 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' });
  });

  it('refuses anonymous, tampered, mismatching and expired requests with 403', async () => {
    const { clock, storage } = setup();
    const up = await storage.presignUpload('k', {
      contentType: 'image/jpeg',
      contentLength: 10,
      expiresInS: 300,
      now: clock.now(),
    });

    // another content type or another size breaks a signed header
    expect(storage.upload(up, body, { 'Content-Type': 'image/png' })).toMatchObject({
      status: 403,
      code: 'SignatureDoesNotMatch',
    });
    expect(storage.upload(up, Buffer.from('01234567890'))).toMatchObject({
      status: 403,
      code: 'SignatureDoesNotMatch',
    });
    // a signed PUT is not a signed GET, and a forged signature is refused
    expect(storage.handleHttp('GET', up.url)).toMatchObject({ status: 403, code: 'SignatureDoesNotMatch' });
    const forged = up.url.replace(/X-Mem-Signature=[0-9a-f]+/, `X-Mem-Signature=${'0'.repeat(64)}`);
    expect(storage.handleHttp('PUT', forged, { headers: up.headers, body })).toMatchObject({ status: 403 });
    const otherKey = up.url.replace('/point-media/k?', '/point-media/k2?');
    expect(storage.handleHttp('PUT', otherKey, { headers: up.headers, body })).toMatchObject({ status: 403 });

    expect(storage.upload(up, body).status).toBe(200);
    // private bucket: no anonymous read, whatever the key
    expect(storage.handleHttp('GET', `${storage.baseUrl}/${storage.bucket}/k`)).toMatchObject({
      status: 403,
      code: 'AccessDenied',
    });

    const down = await storage.presignDownload('k', { expiresInS: 300, now: clock.now() });
    clock.advanceSeconds(299);
    expect(storage.download(down.url).status).toBe(200);
    clock.advanceSeconds(1);
    expect(storage.download(down.url)).toMatchObject({
      status: 403,
      code: 'AccessDenied',
      message: 'Request has expired',
    });
    expect(storage.upload(up, body)).toMatchObject({ status: 403, message: 'Request has expired' });
  });

  it('a valid signature on a missing object answers 404', async () => {
    const { clock, storage } = setup();
    const down = await storage.presignDownload('nothing', { expiresInS: 60, now: clock.now() });
    expect(storage.download(down.url)).toMatchObject({ status: 404, code: 'NoSuchKey' });
  });

  it('head/get/put/delete, create-only put, size limit and injected failures', async () => {
    const { storage } = setup();
    expect(await storage.head('a')).toBeNull();
    expect(await storage.get('a')).toBeNull();
    expect(await storage.put('a', body, { contentType: 'image/png', ifNoneMatch: true })).toBe('created');
    expect(await storage.put('a', Buffer.from('x'), { contentType: 'image/png', ifNoneMatch: true })).toBe(
      'exists',
    );
    expect(await storage.get('a')).toEqual(body);
    await expect(storage.get('a', { maxBytes: 9 })).rejects.toMatchObject({ failure: 'too_large' });
    expect(await storage.put('a', Buffer.from('x'), { contentType: 'image/png' })).toBe('created');
    expect((await storage.get('a'))!.toString()).toBe('x');
    await storage.delete('a');
    await storage.delete('a'); // idempotent
    expect(storage.keys()).toEqual([]);

    storage.failNext('get', 'timeout');
    await expect(storage.get('a')).rejects.toBeInstanceOf(ObjectStorageError);
    expect(await storage.get('a')).toBeNull();
    expect(storage.operations.map((o) => o.op)).toEqual([
      'head',
      'get',
      'put',
      'put',
      'get',
      'get',
      'put',
      'get',
      'delete',
      'delete',
      'get',
      'get',
    ]);
  });
});

// S3ObjectStorage itself is not instantiated here: Vitest runs its workers with `--conditions module`, under
// which Node resolves the AWS SDK's internal requires to its bundler-only `dist-es` build and cannot load it.
// The S3 code path is verified against MinIO outside Vitest (docs/progress/notes/pnt-027.md).
describe('S3ObjectStorage — error classification', () => {
  it('classifies SDK and network errors into the port failures', () => {
    const s3err = (name: string, status?: number) =>
      Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    expect(classifyS3Error(s3err('TimeoutError'), 'get').failure).toBe('timeout');
    expect(classifyS3Error(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'get').failure).toBe(
      'timeout',
    );
    expect(classifyS3Error(s3err('InternalError', 500), 'get').failure).toBe('unavailable');
    expect(classifyS3Error(s3err('SlowDown', 503), 'put').failure).toBe('unavailable');
    expect(classifyS3Error(s3err('AccessDenied', 403), 'put').failure).toBe('misconfigured');
    expect(classifyS3Error(s3err('NoSuchBucket', 404), 'head').failure).toBe('misconfigured');
  });
});

describe('object storage selection from the environment', () => {
  it('S3 when an endpoint or static credentials are configured, and always in staging/production', () => {
    expect(selectObjectStorageDriver(env())).toBe('memory');
    expect(selectObjectStorageDriver(env({ APP_ENV: 'local' }))).toBe('memory');
    expect(selectObjectStorageDriver(env({ S3_ENDPOINT: 'http://localhost:9000' }))).toBe('s3');
    expect(selectObjectStorageDriver(env({ S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' }))).toBe('s3');
    expect(selectObjectStorageDriver(env({ S3_ACCESS_KEY_ID: 'a' }))).toBe('memory');
    expect(selectObjectStorageDriver(env({ APP_ENV: 'staging' }))).toBe('s3');
    expect(
      selectObjectStorageDriver(
        env({
          APP_ENV: 'production',
          NODE_ENV: 'production',
          WA_MODE: 'live',
          MOYASAR_MODE: 'live',
          CUSTOMER_PUSH_MODE: 'live',
        }),
      ),
    ).toBe('s3');
  });

  it('builds the in-memory bucket with the media bucket name when no S3 is configured', () => {
    const mem = createObjectStorage(env({ S3_BUCKET_MEDIA: 'media-test' }), new FakeClock());
    expect(mem).toBeInstanceOf(InMemoryObjectStorage);
    expect(mem.driver).toBe('memory');
    expect(mem.bucket).toBe('media-test');
    expect(S3ObjectStorage.name).toBe('S3ObjectStorage'); // importing the module does not load the AWS SDK
  });
});
