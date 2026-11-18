import { readFileSync } from 'node:fs';
import { EnvError, loadEnv } from '@point/server';
import { SUBSCRIPTION_TERMS_VERSION } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { testEnv } from './test-env.js';

// PNT-002 AC3: the process stops at boot with a clear message when a required variable is missing.
describe('environment validation', () => {
  it('accepts a complete configuration', () => {
    expect(testEnv().DATABASE_URL).toContain('postgres://');
  });

  it('names every missing required variable', () => {
    try {
      loadEnv({ NODE_ENV: 'test' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as Error).message;
      for (const name of [
        'APP_BASE_URL',
        'DATABASE_URL',
        'SESSION_SECRET',
        'CODE_PEPPER',
        'AUTH_SECRET_PEPPER',
        'DATA_ENCRYPTION_KEY',
        'BRAND_STAFF_NAME_AR',
      ]) {
        expect(msg).toContain(name);
      }
    }
  });

  it('rejects a short DATA_ENCRYPTION_KEY and a non-UTC TZ', () => {
    expect(() => testEnv({ DATA_ENCRYPTION_KEY: Buffer.from('short').toString('base64') })).toThrow(
      /DATA_ENCRYPTION_KEY/,
    );
    expect(() => testEnv({ TZ: 'Asia/Riyadh' })).toThrow(/TZ/);
  });

  it('refuses live WhatsApp outside staging/production', () => {
    expect(() => testEnv({ WA_MODE: 'live' })).toThrow(/WA_MODE/);
  });

  // DEC-616: the purchase consent names the version of the terms text the customer app ships (C-24)
  it('defaults the subscription terms version to the one the app ships, as .env.example does', () => {
    expect(testEnv().CUSTOMER_SUBSCRIPTION_TERMS_VERSION).toBe(SUBSCRIPTION_TERMS_VERSION);
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    expect(example).toMatch(
      new RegExp(
        `^CUSTOMER_SUBSCRIPTION_TERMS_VERSION=${SUBSCRIPTION_TERMS_VERSION.replace(/\./g, '\\.')}\\s`,
        'm',
      ),
    );
  });
});
