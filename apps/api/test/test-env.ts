import { loadEnv, type Env } from '@point/server';

/** A valid configuration for API tests (no real secrets: random-looking fixed test values). */
export function testEnv(overrides: Record<string, string> = {}): Env {
  const b64 = (seed: string) => Buffer.from(seed.padEnd(32, '.')).toString('base64');
  return loadEnv({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    TZ: 'UTC',
    APP_BASE_URL: 'http://localhost:5173',
    BRAND_STAFF_NAME_AR: 'STAFF_AR',
    BRAND_STAFF_NAME_EN: 'POINT',
    BRAND_CUSTOMER_NAME_AR: 'CUSTOMER_AR',
    BRAND_CUSTOMER_NAME_EN: 'MASAF',
    DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/none',
    SESSION_SECRET: b64('session-secret-for-tests'),
    SESSION_COOKIE_NAME: 'point_sid',
    SESSION_COOKIE_SECURE: 'false',
    CODE_PEPPER: b64('code-pepper-for-tests'),
    AUTH_SECRET_PEPPER: b64('auth-pepper-for-tests'),
    DATA_ENCRYPTION_KEY: b64('data-key-for-tests'),
    DATA_ENCRYPTION_KEY_ID: 'test1',
    LOG_LEVEL: 'error',
    METRICS_ENABLED: 'false',
    ...overrides,
  });
}

export const ORIGIN = 'http://localhost:5173';
/** Headers every unsafe request needs (CSRF, DEC-29). */
export const CSRF = { 'X-Requested-With': 'point-web', Origin: ORIGIN };
