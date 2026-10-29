// Process environments of a harness run: the api and the worker as production builds (NODE_ENV=production) on
// a dedicated database, the WhatsApp simulator as their Graph API. Every secret is random per run; brand names
// come from .env.example (canon §1: never literals in code).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './deps.mjs';

const b64 = () => randomBytes(32).toString('base64');
const token = (prefix) => `${prefix}-${randomBytes(16).toString('hex')}`;

/** BRAND_* values of .env.example. */
export function brandEnv() {
  const out = {};
  for (const line of readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n')) {
    const m = /^(BRAND_[A-Z_]+)=([^#]*)/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  for (const k of [
    'BRAND_STAFF_NAME_AR',
    'BRAND_STAFF_NAME_EN',
    'BRAND_CUSTOMER_NAME_AR',
    'BRAND_CUSTOMER_NAME_EN',
  ])
    if (!out[k]) throw new Error(`.env.example has no ${k}`);
  return out;
}

/** The variables a child process inherits from the harness: only what Node and the OS need. */
export function baseEnv() {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot'];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
}

/**
 * The configuration shared by the api and the worker of one run.
 * @param {{ dbUrl: string, ports: { api: number, metrics: number, sim: number }, appEnv?: string, overrides?: Record<string,string> }} o
 */
export function serverEnv(o) {
  const wa = {
    WA_ACCESS_TOKEN: token('sim-access'),
    WA_APP_SECRET: token('sim-app'),
    WA_VERIFY_TOKEN: token('sim-verify'),
  };
  return {
    ...brandEnv(),
    NODE_ENV: 'production',
    APP_ENV: o.appEnv ?? 'local',
    TZ: 'UTC',
    LOG_LEVEL: 'info',
    APP_VERSION: 'harness',
    APP_BASE_URL: `http://127.0.0.1:${o.ports.api}`,
    API_PORT: String(o.ports.api),
    DATABASE_URL: o.dbUrl,
    SESSION_SECRET: b64(),
    CODE_PEPPER: b64(),
    AUTH_SECRET_PEPPER: b64(),
    DATA_ENCRYPTION_KEY: b64(),
    DATA_ENCRYPTION_KEY_ID: 'run1',
    // plain http on 127.0.0.1: the __Host- prefix needs Secure (https); the cookie name changes nothing measured
    SESSION_COOKIE_NAME: 'point_sid',
    SESSION_COOKIE_SECURE: 'false',
    WA_MODE: 'simulator',
    WA_GRAPH_BASE_URL: `http://127.0.0.1:${o.ports.sim}`,
    WA_API_VERSION: 'v26.0',
    WA_BUSINESS_ACCOUNT_ID: 'SIM-WABA',
    WA_PHONE_NUMBER_ID: 'SIM-PHONE',
    WA_DISPLAY_PHONE_E164: '+966500000999',
    ...wa,
    METRICS_ENABLED: 'true',
    METRICS_PORT: String(o.ports.metrics),
    WORKER_ID: '',
    ...(o.overrides ?? {}),
  };
}

/** The simulator of the run: signs with the api's app secret, posts to its webhook, Meta-like redeliveries. */
export function simulatorEnv(server, o) {
  return {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    PORT: String(o.ports.sim),
    HOST: '127.0.0.1',
    APP_SECRET: server.WA_APP_SECRET,
    ACCESS_TOKEN: server.WA_ACCESS_TOKEN,
    VERIFY_TOKEN: server.WA_VERIFY_TOKEN,
    PHONE_NUMBER_ID: server.WA_PHONE_NUMBER_ID,
    WABA_ID: server.WA_BUSINESS_ACCOUNT_ID,
    DISPLAY_PHONE_E164: server.WA_DISPLAY_PHONE_E164,
    WEBHOOK_URL: `http://127.0.0.1:${o.ports.api}/webhooks/whatsapp`,
    AUTO_STATUSES: 'true',
    // Meta retries an unanswered delivery for days (12 F-08); six retries over about a minute stand in for it
    WEBHOOK_RETRIES: '6',
    WEBHOOK_RETRY_DELAY_MS: '1000',
    WEBHOOK_TIMEOUT_MS: '10000',
    ...(o.overrides ?? {}),
  };
}
