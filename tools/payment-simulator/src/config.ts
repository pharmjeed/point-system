export const DEFAULT_PORT = 4020;

/** The simulator's secret and publishable keys (test-mode prefixes, never a live key). */
export const DEFAULT_SECRET_KEY = 'sk_test_point_simulator_secret';
export const DEFAULT_PUBLISHABLE_KEY = 'pk_test_point_simulator_publishable';
export const DEFAULT_WEBHOOK_SECRET = 'point-simulator-webhook-secret';

/** Runtime configuration (mutable through PATCH /_sim/config). */
export interface PaymentSimulatorConfig {
  /** where payment events are POSTed (the API's /webhooks/payments/moyasar) */
  webhookUrl: string | null;
  /** the webhook's shared secret, sent as `secret_token` in every event body (Moyasar's mechanism) */
  webhookSecret: string;
  /** the only secret key accepted (HTTP Basic, the key as user name, empty password) */
  secretKey: string;
  /** the only publishable key accepted (card tokenization, as from the payer's device) */
  publishableKey: string;
  /** send an event for every status change; off = events only through the control API */
  autoWebhooks: boolean;
  /** retries after a non-2xx answer (Moyasar retries 5 more times then drops the event) */
  webhookRetries: number;
  webhookTimeoutMs: number;
  /** payments per page of GET /v1/payments */
  pageSize: number;
  accountName: string;
}

export interface PaymentSimulatorOptions extends Partial<PaymentSimulatorConfig> {
  /** Listen port; 0 picks a free port (default for startPaymentSimulator). */
  port?: number;
  host?: string;
  /** Environment used for the production guard (default process.env). */
  env?: Record<string, string | undefined>;
  /** The simulator's clock (tests pass the API's FakeClock so created_at matches the server's days). */
  now?: () => Date;
  /** Log sink (one line per event, never a card number). Silent by default. */
  logger?: (line: string) => void;
}

export function defaultConfig(overrides: Partial<PaymentSimulatorConfig> = {}): PaymentSimulatorConfig {
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return {
    webhookUrl: null,
    webhookSecret: DEFAULT_WEBHOOK_SECRET,
    secretKey: DEFAULT_SECRET_KEY,
    publishableKey: DEFAULT_PUBLISHABLE_KEY,
    autoWebhooks: true,
    webhookRetries: 0,
    webhookTimeoutMs: 10_000,
    pageSize: 20,
    accountName: 'payment-simulator',
    ...(clean as Partial<PaymentSimulatorConfig>),
  };
}

export class ProductionRefusedError extends Error {
  override readonly name = 'ProductionRefusedError';
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** The simulator never runs in production (DEC-510): production talks to the gateway with MOYASAR_MODE=live. */
export function assertNotProduction(env: Record<string, string | undefined>): void {
  for (const key of ['APP_ENV', 'NODE_ENV'] as const) {
    if (env[key]?.trim().toLowerCase() === 'production') {
      throw new ProductionRefusedError(
        `payment-simulator refuses to start: ${key}=production. The payment simulator is for local development and tests only; production uses the gateway (MOYASAR_MODE=live).`,
      );
    }
  }
}

/** A live key never reaches the simulator, and the simulator never accepts one (DEC-510). */
export function assertTestKey(name: string, key: string): void {
  if (/^(sk|pk)_live_/.test(key)) throw new ConfigError(`${name} must not be a live key`);
}

function pick(env: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function intFrom(env: Record<string, string | undefined>, key: string, min = 0): number | undefined {
  const raw = pick(env, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min)
    throw new ConfigError(`${key} must be an integer ≥ ${min} (got "${raw}")`);
  return Number(raw);
}

/** CLI configuration; the API's MOYASAR_* names are accepted so that one .env serves both. */
export function optionsFromEnv(env: Record<string, string | undefined>): PaymentSimulatorOptions {
  const webhookUrl = pick(env, 'WEBHOOK_URL');
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl))
    throw new ConfigError('WEBHOOK_URL must be an http(s) URL');
  const secretKey = pick(env, 'SECRET_KEY', 'MOYASAR_SECRET_KEY');
  const publishableKey = pick(env, 'PUBLISHABLE_KEY', 'MOYASAR_PUBLISHABLE_KEY');
  if (secretKey) assertTestKey('SECRET_KEY', secretKey);
  if (publishableKey) assertTestKey('PUBLISHABLE_KEY', publishableKey);
  const port = intFrom(env, 'PORT');
  if (port !== undefined && port > 65535) throw new ConfigError('PORT must be ≤ 65535');
  return {
    port: port ?? DEFAULT_PORT,
    host: pick(env, 'HOST') ?? '0.0.0.0',
    webhookUrl: webhookUrl ?? null,
    webhookSecret: pick(env, 'WEBHOOK_SECRET', 'MOYASAR_WEBHOOK_SECRET'),
    secretKey,
    publishableKey,
    webhookRetries: intFrom(env, 'WEBHOOK_RETRIES'),
    pageSize: intFrom(env, 'PAGE_SIZE', 1),
    env,
  };
}
