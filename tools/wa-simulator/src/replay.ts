// `node dist/replay.js <scenario.json | builtin-name> [paramsJson]` — replays a scenario against a running
// simulator (SIM_URL, default http://localhost:4010) and prints each webhook delivery.
import { existsSync } from 'node:fs';
import { SimulatorClient } from './client.js';
import type { ScenarioResult } from './types.js';

async function main(argv: string[]): Promise<number> {
  const [target, params] = argv;
  if (!target) {
    console.error('usage: replay <scenario.json | builtin-name> [paramsJson]');
    return 2;
  }
  const client = new SimulatorClient(process.env.SIM_URL ?? 'http://localhost:4010');
  const result: ScenarioResult = existsSync(target)
    ? await client.runScenarioFile(target)
    : await client.runScenario(target, params ? (JSON.parse(params) as Record<string, unknown>) : {});
  for (const d of result.deliveries) {
    console.log(
      `${d.kind.padEnd(18)} ${String(d.httpStatus ?? d.error).padEnd(6)} sig=${d.signature} sha256=${d.bodySha256.slice(0, 12)}`,
    );
  }
  const failed = result.deliveries.filter((d) => !d.ok).length;
  console.log(
    `${result.name}: ${result.steps.length} steps, ${result.deliveries.length} deliveries, ${failed} not 2xx`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
