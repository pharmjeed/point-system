import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const endpoint = process.env.TEST_S3_ENDPOINT;
const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * Opt-in check of S3ObjectStorage against a real S3-compatible server, e.g. the private MinIO of
 * infra/compose:
 *
 *   pnpm --filter @point/shared --filter @point/db --filter @point/server build
 *   TEST_S3_ENDPOINT=http://localhost:9000 TEST_DATABASE_URL=… pnpm test:int packages/server/test/media-s3.int.test.ts
 *
 * (TEST_S3_ACCESS_KEY_ID / TEST_S3_SECRET_ACCESS_KEY default to the compose credentials). It runs in a child
 * Node process on the compiled package: Vitest starts its workers with `--conditions module`, under which
 * Node resolves the AWS SDK's internal requires to its bundler-only `dist-es` build and cannot load it.
 */
describe.skipIf(!endpoint)('S3ObjectStorage against a real S3/MinIO (opt-in, TEST_S3_ENDPOINT)', () => {
  it('signed PUT/GET, signed headers, expiry, private bucket, create-only put, failure classes', () => {
    expect(existsSync(dist), 'build @point/server first (see the comment above)').toBe(true);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        MEDIA_S3_DIST: pathToFileURL(dist).href,
        MEDIA_S3_ENDPOINT: endpoint,
        MEDIA_S3_KEY: process.env.TEST_S3_ACCESS_KEY_ID ?? 'minio',
        MEDIA_S3_SECRET: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'minio-secret',
        MEDIA_S3_BUCKET: process.env.TEST_S3_BUCKET ?? 'point-media-test',
      },
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('s3 checks: ok');
  });
});

const SCRIPT = String.raw`
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { S3ObjectStorage, ObjectStorageError } = await import(process.env.MEDIA_S3_DIST);
const sdk = createRequire(new URL('.', process.env.MEDIA_S3_DIST))('@aws-sdk/client-s3');
const endpoint = process.env.MEDIA_S3_ENDPOINT;
const Bucket = process.env.MEDIA_S3_BUCKET;
const opts = { bucket: Bucket, region: 'us-east-1', endpoint, forcePathStyle: true,
  accessKeyId: process.env.MEDIA_S3_KEY, secretAccessKey: process.env.MEDIA_S3_SECRET };
const s = new S3ObjectStorage(opts);
try { await s.client.send(new sdk.HeadBucketCommand({ Bucket })); }
catch { await s.client.send(new sdk.CreateBucketCommand({ Bucket })); }
const body = Buffer.from('not-really-a-jpeg-but-bytes');
const key = 'incoming/test/' + randomUUID();

// presigned PUT bound to type and length
const up = await s.presignUpload(key, { contentType: 'image/jpeg', contentLength: body.length, expiresInS: 60, now: new Date() });
assert.equal((await fetch(up.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body })).status, 403);
assert.equal((await fetch(up.url, { method: 'PUT', headers: up.headers, body: Buffer.concat([body, body]) })).status, 403);
assert.equal((await fetch(up.url, { method: 'PUT', headers: up.headers, body })).status, 200);
assert.deepEqual(await s.head(key), { size: body.length, contentType: 'image/jpeg' });
assert.ok((await s.get(key)).equals(body));
await assert.rejects(s.get(key, { maxBytes: 3 }), (e) => e.failure === 'too_large');

// presigned GET: response headers, expiry; no anonymous access
const get = await s.presignDownload(key, { expiresInS: 60, now: new Date(), contentType: 'image/jpeg', cacheControl: 'private, no-store' });
const ok = await fetch(get.url);
assert.equal(ok.status, 200);
assert.equal(ok.headers.get('cache-control'), 'private, no-store');
const expired = await s.presignDownload(key, { expiresInS: 60, now: new Date(Date.now() - 120000) });
assert.equal((await fetch(expired.url)).status, 403);
assert.equal((await fetch(endpoint + '/' + Bucket + '/' + key)).status, 403);
assert.equal((await fetch(endpoint + '/' + Bucket + '/' + key, { method: 'PUT', body })).status, 403);

// create-only put, delete (idempotent), missing objects
const final = 'org/test/' + randomUUID() + '.jpg';
assert.equal(await s.put(final, body, { contentType: 'image/jpeg', ifNoneMatch: true }), 'created');
assert.equal(await s.put(final, Buffer.from('other'), { contentType: 'image/jpeg', ifNoneMatch: true }), 'exists');
assert.ok((await s.get(final)).equals(body));
for (const k of [key, final]) { await s.delete(k); await s.delete(k); assert.equal(await s.head(k), null); assert.equal(await s.get(k), null); }

// failure classes
const dead = new S3ObjectStorage({ ...opts, endpoint: 'http://127.0.0.1:1', maxAttempts: 1 });
await assert.rejects(dead.head('x'), (e) => e instanceof ObjectStorageError && e.failure === 'timeout');
const wrong = new S3ObjectStorage({ ...opts, secretAccessKey: 'wrong-secret', maxAttempts: 1 });
await assert.rejects(wrong.get('x'), (e) => e instanceof ObjectStorageError && e.failure === 'misconfigured');
await Promise.all([s.close(), dead.close(), wrong.close()]);
console.log('s3 checks: ok');
`;
