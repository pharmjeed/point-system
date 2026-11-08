import { EnvError, deploymentProblems, loadDeployedEnv, trustProxySetting } from '@point/server';
import { describe, expect, it } from 'vitest';
import { testEnv } from './test-env.js';

/** PNT-096: a staging/production configuration that would weaken the session or the origin stops the boot. */
describe('deployment configuration guards', () => {
  const production: Record<string, string> = {
    APP_ENV: 'production',
    WA_MODE: 'live',
    WA_GRAPH_BASE_URL: 'https://graph.facebook.com',
    MOYASAR_MODE: 'live',
    MOYASAR_BASE_URL: 'https://api.moyasar.com',
    CUSTOMER_PUSH_MODE: 'live',
    EINVOICE_MODE: 'live',
    INVOICE_SELLER_LEGAL_NAME_AR: 'شركة الاختبار',
    INVOICE_SELLER_VAT_NUMBER: '399999999900003',
    INVOICE_SELLER_CR_NUMBER: '0000000000',
    INVOICE_SELLER_ADDRESS_AR: 'الرياض',
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
    // staging pays through the payment simulator only (DEC-510)
    const staging = {
      APP_ENV: 'staging',
      MOYASAR_MODE: 'simulator',
      MOYASAR_BASE_URL: 'http://payment-sim:4020',
      CUSTOMER_PUSH_MODE: 'simulator', // and pushes to the simulator only (DEC-519)
      EINVOICE_MODE: 'simulator', // and invoices to the e-invoicing simulator only (DEC-540)
    };
    expect(problems(staging)).toEqual([
      'WA_TEST_RECIPIENT_ALLOWLIST is required in staging with WA_MODE=live (05 §9 rule 2)',
    ]);
    expect(problems({ ...staging, WA_TEST_RECIPIENT_ALLOWLIST: '+966500000001' })).toEqual([]);
    expect(problems({ ...staging, WA_MODE: 'simulator', WA_GRAPH_BASE_URL: 'http://sim:4010' })).toEqual([]);
  });

  it('V2-020 (DEC-510): the payment gateway is live in production only, over https, never the simulator there', () => {
    expect(() =>
      testEnv({ ...production, MOYASAR_MODE: 'simulator', MOYASAR_BASE_URL: 'http://sim:4020' }),
    ).toThrow('MOYASAR_MODE must be live in production');
    for (const APP_ENV of ['local', 'test', 'staging'])
      expect(() =>
        testEnv({ APP_ENV, MOYASAR_MODE: 'live', MOYASAR_BASE_URL: 'https://api.moyasar.com' }),
      ).toThrow('MOYASAR_MODE=live is only allowed in production');
    // simulator mode may not point at the gateway itself
    expect(() => testEnv({ MOYASAR_BASE_URL: 'https://api.moyasar.com' })).toThrow(
      'MOYASAR_BASE_URL must be the payment simulator when MOYASAR_MODE=simulator',
    );
    expect(problems({ MOYASAR_BASE_URL: 'http://api.moyasar.example' })).toEqual([
      'MOYASAR_BASE_URL must be https when MOYASAR_MODE=live',
    ]);
  });

  it('V2-040 (DEC-540): no invoice reaches ZATCA outside production; production names its seller', () => {
    expect(() => testEnv({ ...production, EINVOICE_MODE: 'simulator' })).toThrow(
      'EINVOICE_MODE must be live in production',
    );
    for (const APP_ENV of ['local', 'test', 'staging'])
      expect(() => testEnv({ APP_ENV, EINVOICE_MODE: 'live' })).toThrow(
        'EINVOICE_MODE=live is only allowed in production',
      );
    expect(testEnv({}).EINVOICE_MODE).toBe('simulator');
    expect(problems({ INVOICE_SELLER_VAT_NUMBER: '', INVOICE_SELLER_ADDRESS_AR: '' })).toEqual([
      'INVOICE_SELLER_VAT_NUMBER is required in production (the seller of every invoice)',
      'INVOICE_SELLER_ADDRESS_AR is required in production (the seller of every invoice)',
    ]);
    expect(() => testEnv({ INVOICE_SELLER_VAT_NUMBER: '123456789012345' })).toThrow(
      'INVOICE_SELLER_VAT_NUMBER must be 15 digits starting and ending with 3',
    );
    expect(() => testEnv({ VAT_RATE_BP: '10001' })).toThrow('VAT_RATE_BP must be between 0 and 10000');
  });

  it('V2-016 (DEC-519): customer pushes reach real devices from production only, never simulated there', () => {
    expect(() => testEnv({ ...production, CUSTOMER_PUSH_MODE: 'simulator' })).toThrow(
      'CUSTOMER_PUSH_MODE must be live in production',
    );
    for (const APP_ENV of ['local', 'test', 'staging'])
      expect(() => testEnv({ APP_ENV, CUSTOMER_PUSH_MODE: 'live' })).toThrow(
        'CUSTOMER_PUSH_MODE=live is only allowed in production',
      );
    expect(testEnv({}).CUSTOMER_PUSH_MODE).toBe('simulator');
    expect(testEnv(production).CUSTOMER_PUSH_MODE).toBe('live');
  });

  it("V2-020 (DEC-510): MOYASAR_MODE=test — the gateway's test API from local or staging only, over https", () => {
    const test = { MOYASAR_MODE: 'test', MOYASAR_BASE_URL: 'https://api.moyasar.com' };
    for (const APP_ENV of ['local', 'staging'])
      expect(testEnv({ APP_ENV, ...test }).MOYASAR_MODE).toBe('test');
    for (const APP_ENV of ['test', 'production'])
      expect(() => testEnv({ ...(APP_ENV === 'production' ? production : {}), APP_ENV, ...test })).toThrow(
        APP_ENV === 'production'
          ? 'MOYASAR_MODE must be live in production'
          : 'MOYASAR_MODE=test is only allowed',
      );
    const staging = {
      APP_ENV: 'staging',
      WA_TEST_RECIPIENT_ALLOWLIST: '+966500000001',
      CUSTOMER_PUSH_MODE: 'simulator',
      EINVOICE_MODE: 'simulator',
    };
    expect(problems({ ...staging, ...test })).toEqual([]);
    expect(problems({ ...staging, ...test, MOYASAR_BASE_URL: 'http://api.moyasar.example' })).toEqual([
      'MOYASAR_BASE_URL must be https when MOYASAR_MODE=test',
    ]);
  });

  it('V2-050 (DEC-555, DEC-556): the live template set and the app link of the WhatsApp replies', () => {
    expect(testEnv({}).WA_TEMPLATE_SET).toBe('v1');
    expect(testEnv({ WA_TEMPLATE_SET: 'v2' }).WA_TEMPLATE_SET).toBe('v2');
    expect(() => testEnv({ WA_TEMPLATE_SET: 'v3' })).toThrow('WA_TEMPLATE_SET');
    expect(testEnv({}).CUSTOMER_APP_LINK).toBe('');
    // WhatsApp shows a web link only: a custom-scheme deep link would reach the customer as plain text
    expect(() => testEnv({ CUSTOMER_APP_LINK: 'sa.point.app://home' })).toThrow(
      'CUSTOMER_APP_LINK must be an https URL',
    );
    expect(() => testEnv({ CUSTOMER_APP_LINK: 'http://get.point.sa/app' })).toThrow('https');
    // the .env.example placeholder (a reserved domain) is fine outside production, refused in production
    expect(testEnv({ CUSTOMER_APP_LINK: 'https://point.example/app' }).CUSTOMER_APP_LINK).toBe(
      'https://point.example/app',
    );
    expect(problems({ CUSTOMER_APP_LINK: 'https://point.example/app' })).toEqual([
      'CUSTOMER_APP_LINK is a placeholder in production: set the real app page or leave it empty',
    ]);
    expect(problems({ CUSTOMER_APP_LINK: 'https://get.pointsa.net/app' })).toEqual([]);
    expect(problems({ CUSTOMER_APP_LINK: '' })).toEqual([]);
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
