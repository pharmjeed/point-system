// `pnpm test:race` (PNT-063): the dispatch race suite RACE_LOOPS times in a row (default 50), stopping at the
// first failure, then the schema invariants (docs/06_schema_invariants_test.sql) unless RACE_INVARIANTS=0.
// Knobs: RACE_LOOPS, RACE_ITERATIONS (repetitions of each scenario inside one run), PRIORITY_ITERATIONS (AC-17),
// TEST_DATABASE_URL / ADMIN_DATABASE_URL as for `pnpm test:int` / `pnpm db:invariants`.
import { spawnSync } from 'node:child_process';

const loops = Math.max(1, Number(process.env.RACE_LOOPS ?? 50));
const started = Date.now();
for (let i = 1; i <= loops; i++) {
  const r = spawnSync(
    'npx',
    ['vitest', 'run', '--project', 'integration', 'apps/api/test/dispatch-race.int.test.ts'],
    { stdio: 'inherit', env: process.env },
  );
  if (r.status !== 0) {
    console.error(`[race] run ${i}/${loops} FAILED`);
    process.exit(r.status ?? 1);
  }
  console.log(`[race] run ${i}/${loops} green (${Math.round((Date.now() - started) / 1000)} s)`);
}
if (process.env.RACE_INVARIANTS !== '0') {
  const inv = spawnSync('pnpm', ['db:invariants'], { stdio: 'inherit', env: process.env });
  if (inv.status !== 0) {
    console.error('[race] schema invariants FAILED after the runs');
    process.exit(inv.status ?? 1);
  }
}
console.log(`[race] ${loops} consecutive runs green`);
