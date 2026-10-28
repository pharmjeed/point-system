import type { StatusName, StatusOrder } from './types.js';

export const DEFAULT_PORT = 4010;
export const DEFAULT_PHONE_NUMBER_ID = '100000000000001';
export const DEFAULT_WABA_ID = '200000000000001';
export const DEFAULT_DISPLAY_PHONE_E164 = '+966500000000';
export const STATUS_ORDERS: readonly StatusOrder[] = [
  'natural',
  'reversed',
  'duplicated',
  'reorder',
  'shuffled',
];
export const STATUS_NAMES: readonly StatusName[] = ['sent', 'delivered', 'read', 'failed'];

/** Runtime configuration (mutable through PATCH /_sim/config). */
export interface SimulatorConfig {
  webhookUrl: string | null;
  appSecret: string;
  verifyToken: string | null;
  /** When set, the Graph fake requires exactly this bearer token; otherwise any non-empty token. */
  accessToken: string | null;
  /** When set, only this phone_number_id is accepted; otherwise any id (the last one seen is echoed). */
  phoneNumberId: string | null;
  wabaId: string;
  displayPhoneE164: string;
  autoStatuses: boolean;
  statusDelayMs: number;
  statusOrder: StatusOrder;
  statusSequence: StatusName[];
  webhookRetries: number;
  webhookRetryDelayMs: number;
  webhookTimeoutMs: number;
  templateApprovalDelayMs: number;
  /** Number rules of docs/12 §11.3 (…0000, …1111, …2222). */
  deterministicFaults: boolean;
  /** Add `user_id`/`from_user_id` (BSUID) to every inbound webhook (DEC-35). */
  includeUserIds: boolean;
  /** How long a request is held in channel/fault `timeout` mode before the socket is dropped. */
  hangMs: number;
}

export interface SimulatorOptions extends Partial<SimulatorConfig> {
  /** Listen port; 0 picks a free port (default for startSimulator). */
  port?: number;
  host?: string;
  /** Environment used for the production guard (default process.env). */
  env?: Record<string, string | undefined>;
  /** Log sink (one line per event, numbers masked). Silent by default. */
  logger?: (line: string) => void;
}

export function defaultConfig(overrides: Partial<SimulatorConfig> = {}): SimulatorConfig {
  return {
    webhookUrl: null,
    appSecret: 'wa-sim-test-secret',
    verifyToken: null,
    accessToken: null,
    phoneNumberId: null,
    wabaId: DEFAULT_WABA_ID,
    displayPhoneE164: DEFAULT_DISPLAY_PHONE_E164,
    autoStatuses: true,
    statusDelayMs: 250,
    statusOrder: 'natural',
    statusSequence: ['sent', 'delivered', 'read'],
    webhookRetries: 0,
    webhookRetryDelayMs: 1000,
    webhookTimeoutMs: 10_000,
    templateApprovalDelayMs: 0,
    deterministicFaults: true,
    includeUserIds: true,
    hangMs: 30_000,
    ...stripUndefined(overrides),
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class ProductionRefusedError extends Error {
  override readonly name = 'ProductionRefusedError';
}

/** The simulator must never run in production (docs/05 §9.2, docs/12 §3.2). */
export function assertNotProduction(env: Record<string, string | undefined>): void {
  for (const key of ['APP_ENV', 'NODE_ENV'] as const) {
    if (env[key]?.trim().toLowerCase() === 'production') {
      throw new ProductionRefusedError(
        `wa-simulator refuses to start: ${key}=production. The WhatsApp simulator is for local development and tests only; production uses the live Cloud API (WA_MODE=live).`,
      );
    }
  }
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
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

function boolFrom(env: Record<string, string | undefined>, key: string): boolean | undefined {
  const raw = pick(env, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false (got "${raw}")`);
}

/**
 * Reads the CLI configuration. Names follow the ticket (PORT, WEBHOOK_URL, APP_SECRET, VERIFY_TOKEN,
 * PHONE_NUMBER_ID, DISPLAY_PHONE_E164); the API's WA_* names are accepted as fallbacks so one .env serves both.
 */
export function optionsFromEnv(env: Record<string, string | undefined>): SimulatorOptions {
  const appSecret = pick(env, 'APP_SECRET', 'WA_APP_SECRET');
  if (!appSecret) {
    throw new ConfigError(
      'APP_SECRET is required (the same value as the API WA_APP_SECRET) to sign webhooks.',
    );
  }
  const webhookUrl = pick(env, 'WEBHOOK_URL');
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl))
    throw new ConfigError(`WEBHOOK_URL must be an http(s) URL`);
  const statusOrder = pick(env, 'STATUS_ORDER') as StatusOrder | undefined;
  if (statusOrder && !STATUS_ORDERS.includes(statusOrder)) {
    throw new ConfigError(`STATUS_ORDER must be one of ${STATUS_ORDERS.join(', ')}`);
  }
  const port = intFrom(env, 'PORT');
  if (port !== undefined && port > 65535) throw new ConfigError('PORT must be ≤ 65535');
  return {
    port: port ?? DEFAULT_PORT,
    host: pick(env, 'HOST') ?? '0.0.0.0',
    webhookUrl: webhookUrl ?? null,
    appSecret,
    verifyToken: pick(env, 'VERIFY_TOKEN', 'WA_VERIFY_TOKEN') ?? null,
    accessToken: pick(env, 'ACCESS_TOKEN', 'WA_ACCESS_TOKEN') ?? null,
    phoneNumberId: pick(env, 'PHONE_NUMBER_ID', 'WA_PHONE_NUMBER_ID') ?? null,
    wabaId: pick(env, 'WABA_ID', 'WA_BUSINESS_ACCOUNT_ID'),
    displayPhoneE164: pick(env, 'DISPLAY_PHONE_E164', 'WA_DISPLAY_PHONE_E164'),
    autoStatuses: boolFrom(env, 'AUTO_STATUSES'),
    statusDelayMs: intFrom(env, 'STATUS_DELAY_MS'),
    statusOrder,
    webhookRetries: intFrom(env, 'WEBHOOK_RETRIES'),
    webhookRetryDelayMs: intFrom(env, 'WEBHOOK_RETRY_DELAY_MS'),
    webhookTimeoutMs: intFrom(env, 'WEBHOOK_TIMEOUT_MS', 1),
    templateApprovalDelayMs: intFrom(env, 'TEMPLATE_APPROVAL_DELAY_MS'),
    deterministicFaults: boolFrom(env, 'DETERMINISTIC_FAULTS'),
    includeUserIds: boolFrom(env, 'INCLUDE_USER_IDS'),
    hangMs: intFrom(env, 'HANG_MS', 1),
    env,
  };
}
