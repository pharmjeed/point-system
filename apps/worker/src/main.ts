import 'reflect-metadata';
import { loadEnvOrExit, startMetricsServer } from '@point/server';
import { allHandlers, allProjectors, allServices, type WorkerService } from './handlers.js';
import { createWorker } from './worker.js';

const env = loadEnvOrExit();
const { dispatcher, logger, db, clock } = createWorker({
  env,
  handlers: allHandlers(),
  projectors: allProjectors(),
});
// background services (the SystemMonitor, storage clients) are created before the dispatcher starts
const services = allServices()
  .map((make) => make({ env, db, clock, logger }))
  .filter((s): s is WorkerService => s !== null);
if (env.METRICS_ENABLED) startMetricsServer(env.METRICS_PORT + 1);
await dispatcher.start();
for (const s of services) s.start?.();
logger.info({ worker_id: dispatcher.workerId, handlers: dispatcher.registeredTypes }, 'point-worker started');

const shutdown = async () => {
  logger.info('point-worker stopping');
  for (const s of services)
    await s.stop().catch((err) => logger.error({ err }, 'worker service stop failed'));
  await dispatcher.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
