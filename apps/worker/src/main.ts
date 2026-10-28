import 'reflect-metadata';
import { loadEnvOrExit, startMetricsServer } from '@point/server';
import { allHandlers, allProjectors } from './handlers.js';
import { createWorker } from './worker.js';

const env = loadEnvOrExit();
const { dispatcher, logger, db } = createWorker({
  env,
  handlers: allHandlers(),
  projectors: allProjectors(),
});
if (env.METRICS_ENABLED) startMetricsServer(env.METRICS_PORT + 1);
await dispatcher.start();
logger.info({ worker_id: dispatcher.workerId, handlers: dispatcher.registeredTypes }, 'point-worker started');

const shutdown = async () => {
  logger.info('point-worker stopping');
  await dispatcher.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
