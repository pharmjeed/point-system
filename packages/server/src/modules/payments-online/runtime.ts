import type { Env } from '../../core/config/env.js';
import { loadEnv } from '../../core/config/env.js';
import { createLogger, type Logger } from '../../core/logging/logger.js';
import { SecretResolver } from '../../core/secrets/secret-resolver.js';
import type { PaymentGateway } from './domain/gateway.js';
import { MoyasarGateway } from './infra/moyasar.js';

export interface PaymentsDeps {
  env: Env;
  secrets?: SecretResolver;
  logger?: Logger;
  /** the map `env://` references are read from (default process.env, like the SecretResolver) */
  secretEnv?: Record<string, string | undefined>;
  /** test seam: another gateway (a failing one, a spy) */
  gateway?: PaymentGateway;
  fetch?: typeof fetch;
}

/**
 * Process-wide online-payment dependencies (api controllers and worker jobs): the MOYASAR_* configuration, secret
 * resolution by reference (`env://`, `sm://`, like the WhatsApp secrets) and the gateway adapter. MOYASAR_MODE only
 * chooses where the same adapter points: the gateway in production, tools/payment-simulator everywhere else (loadEnv
 * refuses `live` outside production, DEC-510).
 */
export class PaymentsRuntime {
  readonly env: Env;
  readonly secrets: SecretResolver;
  readonly logger: Logger;
  readonly gateway: PaymentGateway;

  constructor(deps: PaymentsDeps) {
    this.env = deps.env;
    this.secrets = deps.secrets ?? new SecretResolver(deps.secretEnv ?? process.env);
    this.logger = deps.logger ?? createLogger({ level: deps.env.LOG_LEVEL, name: 'point-payments' });
    this.gateway =
      deps.gateway ??
      new MoyasarGateway({
        baseUrl: deps.env.MOYASAR_BASE_URL,
        timeoutMs: deps.env.MOYASAR_HTTP_TIMEOUT_MS,
        secretKey: () => this.secrets.resolve(deps.env.MOYASAR_SECRET_KEY_REF),
        webhookSecrets: async () => {
          const current = await this.secrets.resolve(deps.env.MOYASAR_WEBHOOK_SECRET_REF);
          const previous = deps.env.MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF
            ? await this.secrets.resolve(deps.env.MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF)
            : null;
          return [current, previous].filter((s): s is string => !!s);
        },
        allowLiveKey: deps.env.APP_ENV === 'production' && deps.env.MOYASAR_MODE === 'live',
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
  }
}

let defaultRuntime: PaymentsRuntime | null = null;

/** The worker builds its runtime lazily from process.env (already validated by loadEnvOrExit). */
export function defaultPaymentsRuntime(): PaymentsRuntime {
  defaultRuntime ??= new PaymentsRuntime({ env: loadEnv(process.env) });
  return defaultRuntime;
}
