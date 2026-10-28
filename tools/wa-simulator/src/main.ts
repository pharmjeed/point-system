import { runCli } from './cli.js';

runCli().catch((err: unknown) => {
  console.error('[wa-simulator] failed to start:', err);
  process.exit(1);
});
