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
 * resolution by reference (`env://`, `sm://`, like the WhatsApp secrets) and the gateway adapter. MOYASAR_MODE chooses
 * where the same adapter points and which keys it may send (DEC-510): `live` the gateway from production with
 * `sk_live_` only, `test` the gateway's test API from local or staging with `sk_test_` only, `simulator`
 * tools/payment-simulator (never a live key).
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
        // live only from production (loadEnv refuses it elsewhere; this holds even for a hand-built Env)
        keyPolicy:
          deps.env.MOYASAR_MODE === 'live'
            ? deps.env.APP_ENV === 'production'
              ? 'live'
              : 'simulator'
            : deps.env.MOYASAR_MODE,
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
