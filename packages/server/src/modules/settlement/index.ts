// Public surface of the settlement module (V2-041 / V2-042, DEC-544 … DEC-547): the operators' monthly statements,
// their lines, P-09's commands and reads, O-05 / O-06 and job.settlement_monthly.
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { ensureSettlementScheduled, settlementMonthlyJob } from './application/monthly.js';

export { SettlementHttpModule } from './settlement.module.js';
export {
  computeLines,
  contractOn,
  monthBounds,
  previousMonth,
  saasShares,
  totalsOf,
  type ComputedLine,
  type ContractTerms,
  type MonthBounds,
  type SettlementSources,
  type StatementTotals,
} from './domain/compute.js';
export {
  generateForOrg,
  settledOrganizations,
  statementView,
  SettlementCommands,
  STATEMENT_COLUMNS,
  type GenerateOutcome,
  type StatementRow,
} from './application/statements.js';
export {
  SETTLEMENT_MONTHLY_JOB,
  assertClosedMonth,
  ensureSettlementScheduled,
  generateCommand,
  nextMonthlyRun,
  runMonthly,
  scheduleSettlement,
  settlementMonthlyJob,
} from './application/monthly.js';
export { OperatorSettlementQueries, PlatformSettlementsQueries } from './application/reads.js';

/** worker process: job.settlement_monthly (canon §7.2 V2 row). */
export function settlementJobs(opts: { cron?: string; vatRateBp?: () => number } = {}): JobHandler[] {
  return [settlementMonthlyJob(opts)];
}

/** worker background service: keeps one job.settlement_monthly scheduled (on start, then hourly). */
export function settlementWorkerService(deps: { env: Env; db: Database; clock: Clock; logger: Logger }) {
  let timer: NodeJS.Timeout | null = null;
  const ensure = () =>
    deps.db
      .transaction((tx) => ensureSettlementScheduled(tx, deps.env.SETTLEMENT_MONTHLY_CRON_UTC))
      .catch((err: unknown) =>
        deps.logger.warn({ err: (err as Error).message }, 'settlement run not scheduled'),
      );
  return {
    start() {
      void ensure();
      timer = setInterval(() => void ensure(), 3_600_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
