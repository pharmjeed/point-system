import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhookBody, verifyWebhookSignature } from '../src/index.js';

describe('X-Hub-Signature-256', () => {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [] }],
    text: 'طلب السيارة',
  });

  it('is sha256=<hex HMAC-SHA256(appSecret, rawBody)> over the UTF-8 bytes', () => {
    const sig = signWebhookBody('s3cret', body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig).toBe(
      `sha256=${createHmac('sha256', 's3cret').update(Buffer.from(body, 'utf8')).digest('hex')}`,
    );
    expect(signWebhookBody('s3cret', Buffer.from(body, 'utf8'))).toBe(sig);
  });

  it('verifies with the secret and rejects anything else', () => {
    const sig = signWebhookBody('s3cret', body);
    expect(verifyWebhookSignature('s3cret', body, sig)).toBe(true);
    expect(
      verifyWebhookSignature('s3cret', Buffer.from(body), sig.toUpperCase().replace('SHA256=', 'sha256=')),
    ).toBe(true);
    expect(verifyWebhookSignature('other', body, sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', `${body} `, sig)).toBe(false); // one extra byte
    expect(verifyWebhookSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, sig.slice('sha256='.length))).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, 'sha256=zz')).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, `sha1=${sig.slice(7)}`)).toBe(false);
  });

  it('accepts either secret during app-secret rotation', () => {
    const sig = signWebhookBody('old-secret', body);
    expect(verifyWebhookSignature(['new-secret', 'old-secret'], body, sig)).toBe(true);
    expect(verifyWebhookSignature(['new-secret'], body, sig)).toBe(false);
  });
});
