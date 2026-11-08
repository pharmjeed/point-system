import { z } from 'zod';
import { unknownKillPoints } from '../chaos/kill-points.js';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const secret = (name: string, minBytes: number) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(
      (v) => Buffer.from(v, 'base64').length >= minBytes,
      `${name} must be at least ${minBytes} random bytes (base64)`,
    );

/**
 * Process configuration (05 §8). Operational values (timers, limits, retention) are NOT env vars: they live
 * in venues.settings / organizations.settings (canon §12).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  TZ: z.literal('UTC', { error: 'TZ must be UTC (processes always run in UTC)' }).default('UTC'),
  DISPLAY_TIMEZONE: z.string().default('Asia/Riyadh'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_VERSION: z.string().default('dev'),

  APP_BASE_URL: z.url({ error: 'APP_BASE_URL is required (staff web app origin)' }),
  API_BASE_URL: z.url().optional(),
  API_PORT: int(3000),

  BRAND_STAFF_NAME_AR: z.string().min(1),
  BRAND_STAFF_NAME_EN: z.string().min(1),
  BRAND_CUSTOMER_NAME_AR: z.string().min(1),
  BRAND_CUSTOMER_NAME_EN: z.string().min(1),

  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(20),
  DATABASE_STATEMENT_TIMEOUT_MS: int(5000),
  DATABASE_LOCK_TIMEOUT_MS: int(3000),
  // a pool slot or a new connection not obtained in time → SERVICE_UNAVAILABLE (DEC-PROPOSED-8, 17 §12); 0 = no bound
  DATABASE_CONNECT_TIMEOUT_MS: int(5000),
  DATABASE_SSL: bool.default(false),

  SESSION_SECRET: secret('SESSION_SECRET', 32),
  SESSION_COOKIE_NAME: z.string().default('__Host-point_sid'),
  SESSION_COOKIE_SECURE: bool.default(true),
  // V2 platform console (/platform, DEC-462): its own session cookie, never the staff one. Empty = derived from the
  // staff cookie's prefix: `__Host-point_psid` next to `__Host-point_sid`, `point_psid` next to `point_sid` (local http)
  PLATFORM_SESSION_COOKIE_NAME: z.string().default(''),
  CODE_PEPPER: secret('CODE_PEPPER', 32),
  // argon2id `secret` (pepper) for PINs and passwords, 09 §9.1 (DEC-58)
  AUTH_SECRET_PEPPER: secret('AUTH_SECRET_PEPPER', 32),
  DATA_ENCRYPTION_KEY: z
    .string({ error: 'DATA_ENCRYPTION_KEY is required' })
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'DATA_ENCRYPTION_KEY must be exactly 32 bytes (base64)',
    ),
  DATA_ENCRYPTION_KEY_ID: z.string().default('k1'),

  WA_MODE: z.enum(['live', 'simulator']).default('simulator'),
  WA_GRAPH_BASE_URL: z.url().default('http://localhost:4010'),
  WA_API_VERSION: z.string().default(''), // pinned at go-live after checking Meta's current Graph API version (12, PNT-100)
  WA_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WA_PHONE_NUMBER_ID: z.string().default(''),
  WA_DISPLAY_PHONE_E164: z.string().default(''),
  WA_ACCESS_TOKEN_REF: z.string().default('env://WA_ACCESS_TOKEN'),
  WA_APP_SECRET_REF: z.string().default('env://WA_APP_SECRET'),
  WA_APP_SECRET_PREVIOUS_REF: z.string().default(''),
  WA_VERIFY_TOKEN_REF: z.string().default('env://WA_VERIFY_TOKEN'),
  WA_HTTP_TIMEOUT_MS: int(10000),
  WA_TEST_RECIPIENT_ALLOWLIST: z.string().default(''),

  // V2-020 online payments (DEC-510, DEC-511): the gateway (Moyasar) or its simulator (tools/payment-simulator);
  // `live` in production only, `test` (the gateway's test API, `sk_test_` keys only) in local/staging only — dev,
  // tests, CI and staging can never charge a card
  MOYASAR_MODE: z.enum(['live', 'test', 'simulator']).default('simulator'),
  MOYASAR_BASE_URL: z.url().default('http://localhost:4020'), // https://api.moyasar.com when live
  MOYASAR_SECRET_KEY_REF: z.string().default('env://MOYASAR_SECRET_KEY'),
  MOYASAR_WEBHOOK_SECRET_REF: z.string().default('env://MOYASAR_WEBHOOK_SECRET'),
  MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF: z.string().default(''), // the secret being rotated out, accepted meanwhile
  MOYASAR_HTTP_TIMEOUT_MS: int(10000),
  // job.payments_reconcile: daily, after the Asia/Riyadh day it compares has ended (00:30 UTC = 03:30 Riyadh)
  PAYMENTS_RECONCILE_CRON_UTC: z.string().default('30 0 * * *'),

  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:ops@example.com'),

  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET_MEDIA: z.string().default('point-media'),
  S3_BUCKET_EXPORTS: z.string().default('point-exports'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool.default(true),
  MEDIA_UPLOAD_URL_TTL_S: int(300),
  MEDIA_READ_URL_TTL_S: int(300),
  MEDIA_MAX_BYTES: int(10485760),
  EXPORT_URL_TTL_S: int(300),

  // 07 §1.9 rate-limit classes (PNT-096): one bucket per IP before login, per user (or device) after; 0 = no limit.
  // Off by default when NODE_ENV=test (the API tests send hundreds of requests at a frozen FakeClock time).
  RATE_LIMIT_ENABLED: bool.optional(),
  RATE_LIMIT_AUTH_PER_MIN: int(10), // per IP: login, MFA verify (the account lock is security.max_login_attempts)
  RATE_LIMIT_COMMANDS_PER_MIN: int(60), // per user
  RATE_LIMIT_ACCEPT_PER_10S: int(20), // per user, POST /v1/task-offers/{offerId}/accept, on top of `command`
  RATE_LIMIT_WRITES_PER_MIN: int(30), // per user (auth.self writes)
  RATE_LIMIT_READS_PER_MIN: int(300), // per user
  RATE_LIMIT_DEVICE_PER_MIN: int(60), // per device (session): heartbeat, devices, audio test, telemetry
  RATE_LIMIT_EXPORTS_PER_HOUR: int(5), // per user
  RATE_LIMIT_WEBHOOK_PER_MIN: int(6000), // per source IP (valve only, 05 §14.3)
  // V2-010 customer sign-in codes (DEC-496): on top of the 60 s resend wait, per number and per device per hour
  CUSTOMER_OTP_PER_PHONE_PER_HOUR: int(5),
  CUSTOMER_OTP_PER_DEVICE_PER_HOUR: int(10),
  // V2-010 versions of the texts the customer accepts on C-04 and their public pages (DEC-498); a new version sends
  // every account back to C-04 (profile_complete = false until it is accepted)
  CUSTOMER_TERMS_VERSION: z.string().min(1).max(40).default('2026-11-01'),
  CUSTOMER_PRIVACY_VERSION: z.string().min(1).max(40).default('2026-11-01'),
  CUSTOMER_MARKETING_VERSION: z.string().min(1).max(40).default('2026-11-01'),
  CUSTOMER_TERMS_URL: z.string().default(''),
  CUSTOMER_PRIVACY_URL: z.string().default(''),
  CUSTOMER_MARKETING_URL: z.string().default(''),
  // V2-022 / V2-023 (DEC-521, DEC-524): where the gateway sends the customer back after 3-D Secure (the app's deep
  // link; reaching it changes nothing, DEC-512), the version of the «save the card» consent text (card_on_file), and
  // how long an earlier payment of a visit that waits for 3-D Secure blocks a new one (PAYMENT_IN_PROGRESS)
  CUSTOMER_PAY_CALLBACK_URL: z.string().min(1).default('sa.point.app://pay/return'),
  CUSTOMER_CARD_ON_FILE_VERSION: z.string().min(1).max(40).default('2026-11-01'),
  VISIT_PAYMENT_PENDING_S: int(900),
  // Express `trust proxy` (05 §14.2): hops in front of the api (1 = the reverse proxy), or a subnet list
  TRUST_PROXY: z.string().default('1'),

  WORKER_ID: z.string().default(''),
  WORKER_CONCURRENCY: int(8),
  WORKER_BATCH_SIZE: int(20),
  WORKER_POLL_INTERVAL_MS: int(500),
  WORKER_LEASE_SECONDS: int(30),
  // no sweep intervals here: job.dispatch_sweep runs every 10 §3 SWEEP_INTERVAL (5 s, a constant) and
  // job.heartbeat_sweep every heartbeat.interval_s (canon §12, an organization setting) — server-gaps DEC-PROPOSED-11
  RETENTION_PURGE_CRON_UTC: z.string().default('0 2 * * *'),
  // SystemMonitor loop (outbox_lag, task_stuck, gauges) in the worker and the api; 0 disables it
  MONITOR_INTERVAL_S: int(10),

  WS_PATH: z.string().default('/ws'),
  WS_TRANSPORTS: z.string().default('websocket'),
  REALTIME_NOTIFY_CHANNEL: z.string().default('point_realtime'),
  OUTBOX_NOTIFY_CHANNEL: z.string().default('point_outbox'),

  OTEL_SERVICE_NAME: z.string().default('point-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().default(0.2),
  METRICS_ENABLED: bool.default(true),
  METRICS_PORT: int(9464),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

/** Parses process.env; a missing or invalid required variable stops the process with a clear message (PNT-002 AC3). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const r = envSchema.safeParse(cleaned);
  if (!r.success) {
    throw new EnvError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const env = r.data;
  if (!env.PLATFORM_SESSION_COOKIE_NAME) {
    env.PLATFORM_SESSION_COOKIE_NAME = env.SESSION_COOKIE_NAME.startsWith('__Host-')
      ? '__Host-point_psid'
      : 'point_psid';
  }
  if (env.PLATFORM_SESSION_COOKIE_NAME === env.SESSION_COOKIE_NAME) {
    throw new EnvError(['PLATFORM_SESSION_COOKIE_NAME must differ from SESSION_COOKIE_NAME (DEC-462)']);
  }
  if (env.APP_ENV === 'production' && env.WA_MODE !== 'live') {
    throw new EnvError(['WA_MODE must be live in production']);
  }
  if (env.APP_ENV !== 'production' && env.WA_MODE === 'live' && env.APP_ENV !== 'staging') {
    throw new EnvError([
      'WA_MODE=live is only allowed in staging (with WA_TEST_RECIPIENT_ALLOWLIST) or production',
    ]);
  }
  // V2-020 (DEC-510): no real charge outside production — the gateway's live API is production's only, and
  // production never runs on the simulator
  if (env.APP_ENV === 'production' && env.MOYASAR_MODE !== 'live') {
    throw new EnvError(['MOYASAR_MODE must be live in production']);
  }
  if (env.APP_ENV !== 'production' && env.MOYASAR_MODE === 'live') {
    throw new EnvError([
      'MOYASAR_MODE=live is only allowed in production (dev, test and staging use the simulator)',
    ]);
  }
  if (env.MOYASAR_MODE === 'test' && env.APP_ENV !== 'local' && env.APP_ENV !== 'staging') {
    throw new EnvError([
      "MOYASAR_MODE=test is only allowed in local or staging (the gateway's test API, sk_test_ keys)",
    ]);
  }
  if (env.MOYASAR_MODE === 'simulator' && isGatewayHost(env.MOYASAR_BASE_URL)) {
    throw new EnvError(['MOYASAR_BASE_URL must be the payment simulator when MOYASAR_MODE=simulator']);
  }
  // Web Push (05 §8, 14 §6): both VAPID keys or none (none = the dev sender, or Push disabled outside local)
  if (!!env.VAPID_PUBLIC_KEY !== !!env.VAPID_PRIVATE_KEY) {
    throw new EnvError(['VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together']);
  }
  if (env.VAPID_PUBLIC_KEY && !/^(mailto:|https:)/.test(env.VAPID_SUBJECT)) {
    throw new EnvError(['VAPID_SUBJECT must be a mailto: or https: URL']);
  }
  // V2-010: the public pages of the customer texts are links the app opens (C-04)
  for (const k of ['CUSTOMER_TERMS_URL', 'CUSTOMER_PRIVACY_URL', 'CUSTOMER_MARKETING_URL'] as const) {
    if (env[k] && !/^https?:\/\/[^\s]+$/.test(env[k])) throw new EnvError([`${k} must be an http(s) URL`]);
  }
  return env;
}

/**
 * The configuration of a running process (api, worker, command-line tools): loadEnv plus the deployment
 * guards. Unit tests that only need a parsed configuration keep using loadEnv.
 */
export function loadDeployedEnv(source: Record<string, string | undefined> = process.env): Env {
  const env = loadEnv(source);
  const problems = deploymentProblems(env, source);
  if (problems.length) throw new EnvError(problems);
  return env;
}

/**
 * PNT-096: settings a deployment must not get wrong (09 §9.3 cookie, DEC-29 one origin, 05 §9 staging
 * allow-list, 17 H-03). Checked when a process boots (loadDeployedEnv, loadEnvOrExit).
 */
export function deploymentProblems(env: Env, source: Record<string, string | undefined> = {}): string[] {
  const out: string[] = [];
  const hosted = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
  if (env.SESSION_COOKIE_NAME.startsWith('__Host-') && !env.SESSION_COOKIE_SECURE) {
    out.push(
      'SESSION_COOKIE_NAME with the __Host- prefix needs SESSION_COOKIE_SECURE=true (browsers drop it)',
    );
  }
  if (env.PLATFORM_SESSION_COOKIE_NAME.startsWith('__Host-') && !env.SESSION_COOKIE_SECURE) {
    out.push(
      'PLATFORM_SESSION_COOKIE_NAME with the __Host- prefix needs SESSION_COOKIE_SECURE=true (browsers drop it)',
    );
  }
  if (env.WA_MODE === 'live' && new URL(env.WA_GRAPH_BASE_URL).protocol !== 'https:') {
    out.push('WA_GRAPH_BASE_URL must be https when WA_MODE=live');
  }
  if (env.MOYASAR_MODE !== 'simulator' && new URL(env.MOYASAR_BASE_URL).protocol !== 'https:') {
    out.push(`MOYASAR_BASE_URL must be https when MOYASAR_MODE=${env.MOYASAR_MODE}`);
  }
  if (env.APP_ENV === 'staging' && env.WA_MODE === 'live' && !env.WA_TEST_RECIPIENT_ALLOWLIST.trim()) {
    out.push('WA_TEST_RECIPIENT_ALLOWLIST is required in staging with WA_MODE=live (05 §9 rule 2)');
  }
  if (hosted) {
    if (!env.SESSION_COOKIE_SECURE) out.push('SESSION_COOKIE_SECURE must be true in staging/production');
    if (!env.SESSION_COOKIE_NAME.startsWith('__Host-')) {
      out.push('SESSION_COOKIE_NAME must start with __Host- in staging/production (09 §9.3)');
    }
    if (!env.PLATFORM_SESSION_COOKIE_NAME.startsWith('__Host-')) {
      out.push(
        'PLATFORM_SESSION_COOKIE_NAME must start with __Host- in staging/production (09 §9.3, DEC-462)',
      );
    }
    if (new URL(env.APP_BASE_URL).protocol !== 'https:') {
      out.push('APP_BASE_URL must be https in staging/production');
    }
    if (env.API_BASE_URL && new URL(env.API_BASE_URL).origin !== new URL(env.APP_BASE_URL).origin) {
      out.push('API_BASE_URL must be on the origin of APP_BASE_URL (one origin, DEC-29)');
    }
  }
  if (env.APP_ENV === 'production' && source.CHAOS_KILL_AT?.trim()) {
    out.push('CHAOS_KILL_AT is refused in production (17 H-03)');
  } else if (source.CHAOS_KILL_AT?.trim()) {
    // a misspelt point would leave a chaos run silently unarmed
    const unknown = unknownKillPoints(source.CHAOS_KILL_AT);
    if (unknown.length) out.push(`CHAOS_KILL_AT names unknown kill points: ${unknown.join(', ')} (17 H-03)`);
  }
  return out;
}

/** The payment gateway's own hosts (moyasar.com and its subdomains): never the target of simulator mode. */
export function isGatewayHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return host === 'moyasar.com' || host.endsWith('.moyasar.com');
}

/** `trust proxy` for Express: a hop count ("1") or Express's own list syntax ("loopback, 10.0.0.0/8"). */
export function trustProxySetting(value: string): number | string | boolean {
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'false') return false;
  if (v === 'true') return true;
  return v;
}

/** Boot helper for the entry points: print the problems and exit(1). */
export function loadEnvOrExit(source: Record<string, string | undefined> = process.env): Env {
  try {
    return loadDeployedEnv(source);
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
