import { ConfigError, optionsFromEnv, ProductionRefusedError } from './config.js';
import { startPaymentSimulator } from './server.js';

/** `node dist/main.js` (pnpm dev): exits 1 on APP_ENV/NODE_ENV=production, a live key or a bad configuration. */
async function main(): Promise<void> {
  const log = (line: string) => console.log(`[payment-simulator] ${line}`);
  try {
    const opts = optionsFromEnv(process.env);
    const sim = await startPaymentSimulator({ ...opts, logger: log });
    log(`listening on ${opts.host}:${sim.port} — set MOYASAR_BASE_URL=${sim.url} (MOYASAR_MODE=simulator)`);
    log(`webhook → ${sim.state.config.webhookUrl ?? '(not set: PATCH /_sim/config {"webhookUrl"})'}`);
    const stop = () => void sim.close().then(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (err) {
    if (err instanceof ProductionRefusedError || err instanceof ConfigError) {
      console.error(`[payment-simulator] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

void main();
