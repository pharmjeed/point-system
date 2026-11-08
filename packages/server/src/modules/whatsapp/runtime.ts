import type { Env } from '../../core/config/env.js';
import { loadEnv } from '../../core/config/env.js';
import { parseEncryptionKey, type EncryptionKey } from '../../core/crypto/crypto.js';
import { createLogger, type Logger } from '../../core/logging/logger.js';
import { SecretResolver } from '../../core/secrets/secret-resolver.js';
import { ActiveChannelCache } from './infra/channel.js';
import { GraphClient } from './infra/graph-client.js';
import { SendPacer, type ChannelProbe } from './infra/pacer.js';

export interface WhatsappDeps {
  env: Env;
  secrets?: SecretResolver;
  logger?: Logger;
  /** the map `env://` references are read from (default process.env, like the SecretResolver) */
  secretEnv?: Record<string, string | undefined>;
  /** test seam for the Graph client */
  fetch?: typeof fetch;
}

/**
 * Process-wide WhatsApp dependencies (API controllers and worker jobs): configuration (WA_* variables of
 * 05 §8), secret resolution, the Graph client and the webhook's channel cache.
 */
export class WhatsappRuntime {
  readonly env: Env;
  readonly secrets: SecretResolver;
  readonly logger: Logger;
  readonly secretEnv: Record<string, string | undefined>;
  readonly graph: GraphClient;
  readonly channels = new ActiveChannelCache();
  /** last phone-number probe per channel (12 §5.14: at most every 60 s) */
  readonly probes = new Map<string, ChannelProbe>();
  /** last `wa_webhook_silent` check of this process (once a minute at most) */
  lastSilentCheckAt = 0;
  private readonly pacers = new Map<string, SendPacer>();
  private keys: EncryptionKey[] | null = null;

  constructor(deps: WhatsappDeps) {
    this.env = deps.env;
    this.secretEnv = deps.secretEnv ?? process.env;
    this.secrets = deps.secrets ?? new SecretResolver(this.secretEnv);
    this.logger = deps.logger ?? createLogger({ level: deps.env.LOG_LEVEL, name: 'point-whatsapp' });
    this.graph = new GraphClient({
      baseUrl: deps.env.WA_GRAPH_BASE_URL,
      timeoutMs: deps.env.WA_HTTP_TIMEOUT_MS,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  }

  /** Global send pacing of a channel in this process (12 §5.8). */
  pacer(channelId: string): SendPacer {
    let p = this.pacers.get(channelId);
    if (!p) {
      p = new SendPacer();
      this.pacers.set(channelId, p);
    }
    return p;
  }

  /** DATA_ENCRYPTION_KEY (+ id) — decrypts claim_codes.code_ciphertext for W-05 (DEC-38, DEC-57). */
  get encryptionKeys(): EncryptionKey[] {
    this.keys ??= [parseEncryptionKey(this.env.DATA_ENCRYPTION_KEY, this.env.DATA_ENCRYPTION_KEY_ID)];
    return this.keys;
  }

  /**
   * WA_TEST_RECIPIENT_ALLOWLIST (05 §8): staging may only message the listed numbers; production ignores
   * it; local/test environments enforce it when it is set.
   */
  recipientAllowed(phoneE164: string | null): boolean {
    if (this.env.APP_ENV === 'production') return true;
    const list = this.env.WA_TEST_RECIPIENT_ALLOWLIST.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (this.env.APP_ENV !== 'staging' && list.length === 0) return true;
    return phoneE164 !== null && list.includes(phoneE164);
  }
}

let defaultRuntime: WhatsappRuntime | null = null;

/** The worker builds its runtime lazily from process.env (already validated by loadEnvOrExit). */
export function defaultWhatsappRuntime(): WhatsappRuntime {
  defaultRuntime ??= new WhatsappRuntime({ env: loadEnv(process.env) });
  return defaultRuntime;
}
