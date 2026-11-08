import type { InvoiceSeller } from '@point/shared/customer';
import type { Clock } from '../../core/clock/clock.js';
import { SystemClock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import { loadEnv } from '../../core/config/env.js';
import { createLogger, type Logger } from '../../core/logging/logger.js';
import { SecretResolver } from '../../core/secrets/secret-resolver.js';
import { createObjectStorage } from '../media/index.js';
import type { ObjectStorage } from '../media/index.js';
import type { EInvoicingProvider } from './domain/provider.js';
import { SimulatorEInvoicingProvider, UnconfiguredLiveProvider } from './infra/simulator.js';

export interface InvoicingDeps {
  env: Env;
  clock?: Clock;
  secrets?: SecretResolver;
  logger?: Logger;
  /** test seam: another provider (a failing one, a spy) */
  provider?: EInvoicingProvider;
  /** the private bucket the PDFs are written to (the media module's storage) */
  storage?: ObjectStorage;
  secretEnv?: Record<string, string | undefined>;
}

/** Placeholders outside production (DEC-540): never a real number; production refuses to boot without the real ones. */
const PLACEHOLDER = {
  vat: '399999999900003',
  cr: '0000000000',
  address: 'عنوان تجريبي — يُضبط قبل الإطلاق',
};

/**
 * Process-wide invoicing dependencies (api controllers and worker jobs): the provider chosen by EINVOICE_MODE (the
 * simulator, or `live` — which has no adapter yet and refuses every submission, DEC-540), the seller's identity from
 * the configuration, the callback secret by reference and the private object storage of the PDFs.
 */
export class InvoicingRuntime {
  readonly env: Env;
  readonly clock: Clock;
  readonly secrets: SecretResolver;
  readonly logger: Logger;
  readonly provider: EInvoicingProvider;
  private storageInstance: ObjectStorage | null;

  constructor(deps: InvoicingDeps) {
    this.env = deps.env;
    this.clock = deps.clock ?? new SystemClock();
    this.secrets = deps.secrets ?? new SecretResolver(deps.secretEnv ?? process.env);
    this.logger = deps.logger ?? createLogger({ level: deps.env.LOG_LEVEL, name: 'point-invoicing' });
    this.storageInstance = deps.storage ?? null;
    this.provider =
      deps.provider ??
      (deps.env.EINVOICE_MODE === 'live' && deps.env.APP_ENV === 'production'
        ? new UnconfiguredLiveProvider()
        : new SimulatorEInvoicingProvider({
            now: () => this.clock.now(),
            callbackSecrets: async () => {
              const s = await this.secrets.resolve(deps.env.EINVOICE_WEBHOOK_SECRET_REF);
              return s ? [s] : [];
            },
          }));
  }

  /** Makes this runtime the one the payments' documents are issued with (the api module, the worker). */
  use(): this {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the process-wide runtime of the payments' hook
    current = this;
    return this;
  }

  get simulated(): boolean {
    return this.provider.name === 'simulator';
  }

  storage(): ObjectStorage {
    this.storageInstance ??= createObjectStorage(this.env, this.clock, this.logger);
    return this.storageInstance;
  }

  /** POINT as the seller (snapshot written into every invoice). */
  seller(): InvoiceSeller {
    const e = this.env;
    return {
      legal_name_ar: e.INVOICE_SELLER_LEGAL_NAME_AR || `${e.BRAND_CUSTOMER_NAME_AR} (بيانات تجريبية)`,
      legal_name_en: e.INVOICE_SELLER_LEGAL_NAME_EN || `${e.BRAND_CUSTOMER_NAME_EN} (placeholder)`,
      vat_number: e.INVOICE_SELLER_VAT_NUMBER || PLACEHOLDER.vat,
      cr_number: e.INVOICE_SELLER_CR_NUMBER || PLACEHOLDER.cr,
      address_ar: e.INVOICE_SELLER_ADDRESS_AR || PLACEHOLDER.address,
    };
  }
}

let defaultRuntime: InvoicingRuntime | null = null;
let current: InvoicingRuntime | null = null;

/**
 * The runtime the documents of a payment are issued with (the hook runs inside the payments module's transactions,
 * where nothing is injected): the one the api or the worker built last, else the default from process.env.
 */
export function currentInvoicingRuntime(): InvoicingRuntime {
  return current ?? defaultInvoicingRuntime();
}

/** The worker builds its runtime lazily from process.env (already validated by loadEnvOrExit). */
export function defaultInvoicingRuntime(): InvoicingRuntime {
  defaultRuntime ??= new InvoicingRuntime({ env: loadEnv(process.env) });
  return defaultRuntime;
}
