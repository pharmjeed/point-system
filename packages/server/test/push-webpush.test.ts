import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebPushSender } from '../src/modules/notifications/infra/push-transport.js';

/** RFC 8291 + RFC 8188 (aes128gcm) decryption, as a browser does it with its subscription keys. */
function decryptAes128gcm(body: Buffer, ua: ECDH, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2); // the last-record delimiter
  return plain.subarray(0, end).toString('utf8');
}

const b64url = (b: Buffer) => b.toString('base64url');

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * The local «test push service» of 17 §3.1: records each request; answers what the test scripts
 * (status, headers, an optional delay). The production sender (`web-push` request + fetch) is used as is.
 */
describe('WebPushSender — the real web-push request against a local push service', () => {
  let server: Server;
  let base: string;
  const received: Received[] = [];
  const script: { status: number; headers?: Record<string, string>; delayMs?: number }[] = [];
  const vapid = webpush.generateVAPIDKeys();
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const sender = new WebPushSender(
    { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:ops@example.com' },
    { timeoutMs: 300 },
  );
  const req = (payload: string) => ({
    endpoint: `${base}/push/sub-1`,
    p256dh: b64url(ua.getPublicKey()),
    auth: b64url(auth),
    payload,
    ttlSeconds: 25,
    urgency: 'high' as const,
    topic: '4f0c2a7e91d34b8aa1f20c6e5d9b3a17',
  });

  beforeAll(async () => {
    server = createServer((r, res) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => {
        received.push({ method: r.method!, url: r.url!, headers: r.headers, body: Buffer.concat(chunks) });
        const next = script.shift() ?? { status: 201 };
        setTimeout(() => {
          res.writeHead(next.status, next.headers ?? {});
          res.end();
        }, next.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the encrypted payload with the 14 §6.2 headers and a VAPID JWT', async () => {
    const payload = JSON.stringify({ v: 1, kind: 'offer', body: 'تذكرة 125 — افتح التطبيق للقبول' });
    expect(await sender.send(req(payload))).toEqual({ statusCode: 201, retryAfterMs: null, error: null });
    const r = received.at(-1)!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/push/sub-1');
    expect(r.headers).toMatchObject({
      ttl: '25',
      urgency: 'high',
      topic: '4f0c2a7e91d34b8aa1f20c6e5d9b3a17',
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
    });
    const authz = String(r.headers.authorization);
    expect(authz).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(authz).toContain(`k=${vapid.publicKey}`);
    const jwt = JSON.parse(Buffer.from(authz.split('t=')[1]!.split('.')[1]!, 'base64url').toString());
    expect(jwt).toMatchObject({ aud: base, sub: 'mailto:ops@example.com' });
    expect(jwt.exp * 1000).toBeGreaterThan(Date.now());
    // the push service only sees ciphertext; the subscription keys open it
    expect(r.body.toString('utf8')).not.toContain('تذكرة');
    expect(decryptAes128gcm(r.body, ua, auth)).toBe(payload);
  });

  it('reports the push service answers and transport failures (14 §6.6)', async () => {
    script.push({ status: 410 });
    expect(await sender.send(req('{}'))).toEqual({ statusCode: 410, retryAfterMs: null, error: null });
    script.push({ status: 429, headers: { 'retry-after': '3' } });
    expect(await sender.send(req('{}'))).toEqual({ statusCode: 429, retryAfterMs: 3000, error: null });
    script.push({ status: 503 });
    expect((await sender.send(req('{}'))).statusCode).toBe(503);
    script.push({ status: 201, delayMs: 1000 });
    expect(await sender.send(req('{}'))).toEqual({ statusCode: null, retryAfterMs: null, error: 'timeout' });
    const closed = new WebPushSender(
      { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:ops@example.com' },
      { timeoutMs: 500 },
    );
    expect(await closed.send({ ...req('{}'), endpoint: 'http://127.0.0.1:1/push' })).toEqual({
      statusCode: null,
      retryAfterMs: null,
      error: 'network',
    });
  });
});
