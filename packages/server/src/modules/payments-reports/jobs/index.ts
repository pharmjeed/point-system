import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import { deleterForStore, registerMediaObjectDeleter } from '../../../core/hooks/media-objects.js';
import type { Logger } from '../../../core/logging/logger.js';
import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import type { ObjectStorage } from '../../media/index.js';
import {
  createExportsStorage,
  registerExportsStorage,
  registeredExportsStorage,
} from '../infra/exports-storage.js';
import { exportGenerateHandler } from './export-generate.js';

/**
 * Worker handlers of payments-reports (04 §4.2 item 8): `job.export_generate`. The exports storage is the one
 * registered in the process (the worker service below, or the api module) unless one is given (tests).
 */
export function paymentsReportsJobs(
  opts: { storage?: ObjectStorage | (() => ObjectStorage | null) } = {},
): JobHandler[] {
  const given = opts.storage;
  const storage = typeof given === 'function' ? given : given ? () => given : registeredExportsStorage;
  return [exportGenerateHandler(storage)];
}

/**
 * The worker's exports bucket client: used by `job.export_generate` and registered as the `exports` object deleter
 * of `job.retention_purge` (core seam, 04 §4.3: audit-monitoring never talks to S3).
 */
export function paymentsReportsWorkerService(deps: { env: Env; clock: Clock; logger: Logger }) {
  const storage = createExportsStorage(deps.env, deps.clock, deps.logger);
  registerExportsStorage(storage);
  registerMediaObjectDeleter(deleterForStore(storage), 'exports');
  return {
    async stop() {
      registerMediaObjectDeleter(null, 'exports');
      if (registeredExportsStorage() === storage) registerExportsStorage(null);
      await storage.close?.();
    },
  };
}
