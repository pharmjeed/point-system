import { EnvError, deploymentProblems, loadDeployedEnv, trustProxySetting } from '@point/server';
import { describe, expect, it } from 'vitest';
import { testEnv } from './test-env.js';

/** PNT-096: a staging/production configuration that would weaken the session or the origin stops the boot. */
describe('deployment configuration guards', () => {
  const production: Record<string, string> = {
    APP_ENV: 'production',
    WA_MODE: 'live',
    WA_GRAPH_BASE_URL: 'https://graph.facebook.com',
    APP_BASE_URL: 'https://app.example.test',
    API_BASE_URL: 'https://app.example.test',
    SESSION_COOKIE_NAME: '__Host-point_sid',
    SESSION_COOKIE_SECURE: 'true',
  };
  const problems = (overrides: Record<string, string> = {}) => {
    const source = { ...production, ...overrides };
    return deploymentProblems(testEnv(source), source);
  };

  it('accepts the documented production settings', () => {
    expect(problems()).toEqual([]);
  });

  it('production needs the __Host- cookie, Secure, https and one origin', () => {
    expect(problems({ SESSION_COOKIE_NAME: 'point_sid' })).toEqual([
      'SESSION_COOKIE_NAME must start with __Host- in staging/production (09 §9.3)',
      // the platform cookie follows the staff cookie's prefix when not set (DEC-462)
      'PLATFORM_SESSION_COOKIE_NAME must start with __Host- in staging/production (09 §9.3, DEC-462)',
    ]);
    expect(problems({ PLATFORM_SESSION_COOKIE_NAME: 'point_psid' })).toEqual([
      'PLATFORM_SESSION_COOKIE_NAME must start with __Host- in staging/production (09 §9.3, DEC-462)',
    ]);
    expect(problems({ SESSION_COOKIE_SECURE: 'false' })).toContain(
      'SESSION_COOKIE_SECURE must be true in staging/production',
    );
    expect(problems({ APP_BASE_URL: 'http://app.example.test', API_BASE_URL: '' })).toEqual([
      'APP_BASE_URL must be https in staging/production',
    ]);
    expect(problems({ API_BASE_URL: 'https://api.example.test' })).toEqual([
      'API_BASE_URL must be on the origin of APP_BASE_URL (one origin, DEC-29)',
    ]);
    expect(problems({ WA_GRAPH_BASE_URL: 'http://graph.example.test' })).toEqual([
      'WA_GRAPH_BASE_URL must be https when WA_MODE=live',
    ]);
    expect(problems({ CHAOS_KILL_AT: 'webhook_after_store_before_ack' })).toEqual([
      'CHAOS_KILL_AT is refused in production (17 H-03)',
    ]);
  });

  it('staging follows the same rules and needs the recipient allow-list when live', () => {
    expect(problems({ APP_ENV: 'staging' })).toEqual([
      'WA_TEST_RECIPIENT_ALLOWLIST is required in staging with WA_MODE=live (05 §9 rule 2)',
    ]);
    expect(problems({ APP_ENV: 'staging', WA_TEST_RECIPIENT_ALLOWLIST: '+966500000001' })).toEqual([]);
    expect(
      problems({ APP_ENV: 'staging', WA_MODE: 'simulator', WA_GRAPH_BASE_URL: 'http://sim:4010' }),
    ).toEqual([]);
  });

  it('a __Host- cookie without Secure is refused in every environment (browsers drop it)', () => {
    const local = {
      APP_ENV: 'local',
      SESSION_COOKIE_NAME: '__Host-point_sid',
      SESSION_COOKIE_SECURE: 'false',
    };
    expect(deploymentProblems(testEnv(local), local)).toEqual([
      'SESSION_COOKIE_NAME with the __Host- prefix needs SESSION_COOKIE_SECURE=true (browsers drop it)',
      // the derived platform cookie (__Host-point_psid) has the same need (DEC-462)
      'PLATFORM_SESSION_COOKIE_NAME with the __Host- prefix needs SESSION_COOKIE_SECURE=true (browsers drop it)',
    ]);
    // local http keeps point_sid without Secure
    expect(deploymentProblems(testEnv({ APP_ENV: 'local' }))).toEqual([]);
  });

  it('the boot loader (api, worker, tools) throws EnvError with every problem', () => {
    const b64 = (s: string) => Buffer.from(s.padEnd(32, '.')).toString('base64');
    const source = {
      ...production,
      NODE_ENV: 'production',
      BRAND_STAFF_NAME_AR: 'S',
      BRAND_STAFF_NAME_EN: 'S',
      BRAND_CUSTOMER_NAME_AR: 'C',
      BRAND_CUSTOMER_NAME_EN: 'C',
      DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none',
      SESSION_SECRET: b64('a'),
      CODE_PEPPER: b64('b'),
      AUTH_SECRET_PEPPER: b64('c'),
      DATA_ENCRYPTION_KEY: b64('d'),
    };
    expect(loadDeployedEnv(source).APP_ENV).toBe('production');
    try {
      loadDeployedEnv({ ...source, SESSION_COOKIE_SECURE: 'false', APP_BASE_URL: 'http://app.example.test' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      // __Host- without Secure (staff and platform cookies, DEC-462), Secure, https, one origin
      expect((e as EnvError).problems).toHaveLength(5);
    }
  });

  it('TRUST_PROXY: a hop count or an Express subnet list', () => {
    expect(testEnv().TRUST_PROXY).toBe('1');
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });

  it('rate limiting is on by default outside NODE_ENV=test and can be forced either way', () => {
    expect(testEnv().RATE_LIMIT_ENABLED).toBeUndefined();
    expect(testEnv({ RATE_LIMIT_ENABLED: 'true' }).RATE_LIMIT_ENABLED).toBe(true);
    expect(testEnv({ RATE_LIMIT_ENABLED: 'false' }).RATE_LIMIT_ENABLED).toBe(false);
  });
});
