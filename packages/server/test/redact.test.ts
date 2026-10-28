import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logging/logger.js';
import { findSensitiveKeys, maskPhone, redact } from '../src/core/logging/redact.js';

describe('log redaction (PNT-006 AC3)', () => {
  const sample = {
    request_id: 'req_1',
    phone_e164: '+966551234123',
    customer_phone: '+966551234123',
    wa_id: '966551234123',
    claim_code: '123456',
    code: '654321',
    token: 'abc',
    action_token: 'tok',
    pin: '112233',
    password: 'hunter2hunter2',
    mfa_secret_enc: 'k1:..',
    code_ciphertext: 'k1:..',
    raw_body: '{...}',
    push_endpoint: 'https://push',
    push_p256dh: 'x',
    push_auth: 'y',
    headers: { cookie: '__Host-point_sid=abc', authorization: 'Bearer x' },
    nested: { secret: 's', ok: 1 },
    error: { code: 'TASK_ALREADY_CLAIMED' },
  };

  it('replaces every sensitive field', () => {
    const out = redact(sample) as any;
    for (const k of [
      'phone_e164',
      'customer_phone',
      'wa_id',
      'claim_code',
      'code',
      'token',
      'action_token',
      'pin',
      'password',
      'mfa_secret_enc',
      'code_ciphertext',
      'raw_body',
      'push_endpoint',
      'push_p256dh',
      'push_auth',
    ]) {
      expect(out[k], k).toBe('[REDACTED]');
    }
    expect(out.headers.cookie).toBe('[REDACTED]');
    expect(out.headers.authorization).toBe('[REDACTED]');
    expect(out.nested).toEqual({ secret: '[REDACTED]', ok: 1 });
    expect(out.error.code).toBe('TASK_ALREADY_CLAIMED');
    expect(out.request_id).toBe('req_1');
  });

  it('log lines never contain a value from the redaction list', async () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger({ level: 'info', destination: dest as any });
    logger.info(sample, 'command');
    await new Promise((r) => setImmediate(r));
    const text = lines.join('\n');
    for (const secret of [
      '+966551234123',
      '966551234123',
      '123456',
      '654321',
      'hunter2hunter2',
      '__Host-point_sid=abc',
      'Bearer x',
      '112233',
      'https://push',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('TASK_ALREADY_CLAIMED');
  });

  it('finds sensitive keys in payloads', () => {
    expect(findSensitiveKeys({ ticket_id: 'x', notification_id: 'y' })).toEqual([]);
    expect(findSensitiveKeys({ a: { claim_code: '1' } })).toEqual(['a.claim_code']);
  });

  it('canon names that only describe a code, PIN, token or phone are not sensitive (DEC-131)', () => {
    const payload = {
      code_expires_at: '2026-10-29T18:00:00.000Z',
      handover: { code_ttl_min: 30 },
      security: { pin_length: 6, reveal_phone_per_hour: 20 },
      wa: { action_token_ttl_h: 24 },
    };
    expect(findSensitiveKeys(payload)).toEqual([]);
    expect(redact(payload)).toEqual(payload);
    // the values they describe stay redacted
    expect(findSensitiveKeys({ handover_code: '123456', pin: '314159', action_token: 't' })).toEqual([
      'handover_code',
      'pin',
      'action_token',
    ]);
  });

  it('masks phones as 05•••••123', () => {
    expect(maskPhone('+966551234123')).toBe('05•••••123');
  });
});
