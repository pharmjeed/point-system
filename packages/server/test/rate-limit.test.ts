/**
 * PNT-096 (unit): the token buckets and the 07 §1.9 class policy behind the RATE_LIMITED guards.
 */
import { ROUTES } from '@point/shared';
import { describe, expect, it } from 'vitest';
import {
  TokenBucketLimiter,
  clientAddressKey,
  extraRateRules,
  loadEnv,
  rateLimitClassOf,
  rateLimitRules,
  type Env,
} from '../src/index.js';

function env(overrides: Record<string, string> = {}): Env {
  const b64 = (s: string) => Buffer.from(s.padEnd(32, '.')).toString('base64');
  return loadEnv({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    APP_BASE_URL: 'http://localhost:5173',
    BRAND_STAFF_NAME_AR: 'S',
    BRAND_STAFF_NAME_EN: 'S',
    BRAND_CUSTOMER_NAME_AR: 'C',
    BRAND_CUSTOMER_NAME_EN: 'C',
    DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none',
    SESSION_SECRET: b64('a'),
    SESSION_COOKIE_NAME: 'point_sid',
    SESSION_COOKIE_SECURE: 'false',
    CODE_PEPPER: b64('b'),
    AUTH_SECRET_PEPPER: b64('c'),
    DATA_ENCRYPTION_KEY: b64('d'),
    ...overrides,
  });
}

describe('TokenBucketLimiter', () => {
  it('allows a burst up to the limit, then answers with the wait for one more token', () => {
    const l = new TokenBucketLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) {
      const d = l.take('auth:ip:1.2.3.4', 10, 60_000, t0);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(9 - i);
    }
    const refused = l.take('auth:ip:1.2.3.4', 10, 60_000, t0);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterS: 6, resetS: 60 });
    // another key has its own bucket
    expect(l.take('auth:ip:5.6.7.8', 10, 60_000, t0).allowed).toBe(true);
  });

  it('refills continuously: one token every window/limit', () => {
    const l = new TokenBucketLimiter();
    const t0 = 5_000;
    for (let i = 0; i < 5; i++) l.take('k', 5, 3_600_000, t0); // export: 5 per hour
    expect(l.take('k', 5, 3_600_000, t0).allowed).toBe(false);
    expect(l.take('k', 5, 3_600_000, t0 + 11 * 60_000).allowed).toBe(false);
    const d = l.take('k', 5, 3_600_000, t0 + 13 * 60_000); // one token every 12 minutes
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(0);
    // after a full window the bucket is full again
    expect(l.take('k', 5, 3_600_000, t0 + 2 * 3_600_000).remaining).toBe(4);
  });

  it('a refused request consumes nothing', () => {
    const l = new TokenBucketLimiter();
    l.take('k', 1, 10_000, 0);
    expect(l.take('k', 1, 10_000, 0).allowed).toBe(false);
    expect(l.take('k', 1, 10_000, 0).allowed).toBe(false);
    expect(l.take('k', 1, 10_000, 10_000).allowed).toBe(true);
  });

  it('bounds its memory: least recently used keys go first, idle full buckets are swept', () => {
    const l = new TokenBucketLimiter({ maxKeys: 3, sweepEveryMs: 1_000 });
    l.take('a', 2, 1_000, 0);
    l.take('b', 2, 1_000, 0);
    l.take('c', 2, 1_000, 0);
    l.take('a', 2, 1_000, 1); // a is now the most recent
    l.take('d', 2, 1_000, 1); // evicts b
    expect(l.size).toBe(3);
    l.take('b', 2, 1_000, 2); // b starts afresh (allowed), evicts c
    expect(l.size).toBe(3);
    l.take('e', 2, 1_000, 5_000); // sweep: a, d, b are full again and forgotten
    expect(l.size).toBe(1);
  });
});

describe('07 §1.9 policy', () => {
  it('defaults: auth 10/min per IP, command 60/min, write 30/min, read 300/min per user, device 60/min, export 5/h, webhook valve per IP, health free', () => {
    const r = rateLimitRules(env());
    expect(r.auth).toEqual({ name: 'auth', limit: 10, windowMs: 60_000, subject: 'ip' });
    expect(r.command).toEqual({ name: 'command', limit: 60, windowMs: 60_000, subject: 'user' });
    expect(r.write).toEqual({ name: 'write', limit: 30, windowMs: 60_000, subject: 'user' });
    expect(r.read).toEqual({ name: 'read', limit: 300, windowMs: 60_000, subject: 'user' });
    expect(r.device).toEqual({ name: 'device', limit: 60, windowMs: 60_000, subject: 'device' });
    expect(r.export).toEqual({ name: 'export', limit: 5, windowMs: 3_600_000, subject: 'user' });
    expect(r.webhook).toEqual({ name: 'webhook', limit: 6000, windowMs: 60_000, subject: 'ip' });
    expect(r.health).toBeNull();
    expect(extraRateRules(env())).toEqual({
      'POST /v1/task-offers/{offerId}/accept': {
        name: 'accept',
        limit: 20,
        windowMs: 10_000,
        subject: 'user',
      },
    });
  });

  it('a class configured with 0 has no application limit; overrides come from the environment', () => {
    const r = rateLimitRules(env({ RATE_LIMIT_WEBHOOK_PER_MIN: '0', RATE_LIMIT_AUTH_PER_MIN: '25' }));
    expect(r.webhook).toBeNull();
    expect(r.auth?.limit).toBe(25);
    expect(extraRateRules(env({ RATE_LIMIT_ACCEPT_PER_10S: '0' }))).toEqual({});
  });

  it('the class of a matched Express route is the ROUTES class; unknown routes use the method default', () => {
    expect(rateLimitClassOf('POST', '/v1/auth/login')).toBe('auth');
    expect(rateLimitClassOf('POST', '/v1/tickets/:ticketId/void')).toBe('command');
    expect(rateLimitClassOf('GET', '/v1/tickets/:ticketId')).toBe('read');
    expect(rateLimitClassOf('PUT', '/v1/me/devices/:deviceId')).toBe('device');
    expect(rateLimitClassOf('POST', '/webhooks/whatsapp')).toBe('webhook');
    expect(rateLimitClassOf('GET', '/health/ready')).toBe('health');
    expect(rateLimitClassOf('GET', '/v1/test/whatever')).toBe('read');
    expect(rateLimitClassOf('POST', '/v1/test/whatever')).toBe('command');
    // every canon route resolves to its own class through the Express form of its path
    for (const r of ROUTES) {
      expect(rateLimitClassOf(r.method, r.path.replace(/\{(\w+)\}/g, ':$1'))).toBe(r.rateLimitClass);
    }
  });

  it('client address keys: IPv4 as is, IPv4-mapped IPv6 unwrapped, IPv6 by /64', () => {
    expect(clientAddressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressKey('2001:db8:85a3:0042:1000:8a2e:0370:7334')).toBe('2001:db8:85a3:42::/64');
    expect(clientAddressKey('2001:db8:85a3:42:ffff::1')).toBe('2001:db8:85a3:42::/64');
    expect(clientAddressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientAddressKey('::1')).toBe('0:0:0:0::/64');
    expect(clientAddressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientAddressKey(undefined)).toBe('unknown');
  });
});
