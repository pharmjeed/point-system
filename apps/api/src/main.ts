import { loadEnvOrExit, startMetricsServer } from '@point/server';
import { createApp } from './bootstrap.js';

const env = loadEnvOrExit();
const app = await createApp({ env });
if (env.METRICS_ENABLED) startMetricsServer(env.METRICS_PORT);
await app.listen(env.API_PORT);
console.log(
  JSON.stringify({ level: 'info', msg: `point-api listening on ${env.API_PORT}`, version: env.APP_VERSION }),
);
