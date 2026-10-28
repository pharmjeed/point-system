import type { Env } from '../../../core/config/env.js';
import { loadEnv } from '../../../core/config/env.js';
import { createLogger, type Logger } from '../../../core/logging/logger.js';
import { createPushSender, type PushSender } from './push-transport.js';

export interface PushRuntimeDeps {
  env: Env;
  logger?: Logger;
  /** test seam: a recording sender, a sender pointed at a local push service */
  sender?: PushSender;
  clock?: { now(): Date };
}

/** Process-wide Web Push dependencies of the worker (VAPID sender, staff brand for the titles). */
export class PushRuntime {
  readonly env: Env;
  readonly logger: Logger;
  readonly sender: PushSender;
  /** canon §1: titles start with the staff brand from `BRAND_STAFF_NAME_AR`, never a literal */
  readonly staffBrandAr: string;

  constructor(deps: PushRuntimeDeps) {
    this.env = deps.env;
    this.logger = deps.logger ?? createLogger({ level: deps.env.LOG_LEVEL, name: 'point-push' });
    this.sender = deps.sender ?? createPushSender(deps.env, this.logger, deps.clock);
    this.staffBrandAr = deps.env.BRAND_STAFF_NAME_AR;
  }
}

let defaultRuntime: PushRuntime | null = null;

/** The worker builds its runtime lazily from process.env (already validated by loadEnvOrExit). */
export function defaultPushRuntime(): PushRuntime {
  defaultRuntime ??= new PushRuntime({ env: loadEnv(process.env) });
  return defaultRuntime;
}
