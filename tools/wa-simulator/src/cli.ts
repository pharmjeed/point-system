import { ConfigError, optionsFromEnv, ProductionRefusedError } from './config.js';
import { mask } from './ids.js';
import { startSimulator, type RunningSimulator } from './server.js';

export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
}

const defaultIo: CliIo = {
  log: (line) => console.log(`[wa-simulator] ${line}`),
  error: (line) => console.error(`[wa-simulator] ${line}`),
  exit: (code) => process.exit(code),
};

/**
 * Entry of `node dist/main.js`. Exits 1 with a clear message on APP_ENV/NODE_ENV=production or bad config.
 * Returns the running simulator (or null when it refused to start).
 */
export async function runCli(
  env: Record<string, string | undefined> = process.env,
  io: CliIo = defaultIo,
): Promise<RunningSimulator | null> {
  let sim: RunningSimulator;
  try {
    const opts = optionsFromEnv(env);
    sim = await startSimulator({ ...opts, logger: io.log });
    const c = sim.state.configView();
    io.log(`listening on ${opts.host}:${sim.port} — Graph base URL ${sim.url} (set WA_GRAPH_BASE_URL to it)`);
    io.log(
      `webhook → ${c.webhookUrl ?? '(not set: PATCH /_sim/config {"webhookUrl"})'} · phone_number_id ${c.phoneNumberId ?? `any (default ${c.effectivePhoneNumberId})`} · display ${mask(c.displayPhoneE164)} · auto statuses ${c.autoStatuses ? `${c.statusOrder}/${c.statusDelayMs}ms` : 'off'}`,
    );
    io.log(`UI ${sim.url}/ · control API ${sim.url}/_sim/*`);
  } catch (err) {
    if (err instanceof ProductionRefusedError || err instanceof ConfigError) {
      io.error(err.message);
      io.exit(1);
      return null;
    }
    throw err;
  }
  const stop = (signal: string): void => {
    io.log(`${signal} received, shutting down`);
    void sim.close().then(() => io.exit(0));
  };
  if (io === defaultIo) {
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }
  return sim;
}
