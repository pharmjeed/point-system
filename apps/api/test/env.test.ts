import { EnvError, loadEnv } from '@point/server';
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
});
