// Public surface of the audit-monitoring module (PNT-090, PNT-091 retention, PNT-092, PNT-094).
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import type { EventProjector, JobHandler } from '../../core/outbox/dispatcher.js';
import {
  createAnalyticsProjector,
  type AnalyticsProjectorOptions,
} from './application/analytics-projector.js';
import { retentionPurgeJob, type RetentionJobOptions } from './jobs/retention-purge.js';
import { SystemMonitor } from './jobs/system-monitor.js';

export { AuditMonitoringHttpModule, ApiSystemMonitor } from './audit-monitoring.module.js';
export { AuditQuery, auditEntryView, type AuditLogFilters } from './application/audit-query.js';
export {
  OutboxAdmin,
  outboxEventView,
  VERSIONED_AGGREGATE_TABLES,
  DEFAULT_OUTBOX_LIST_STATUSES,
  type RetryOutcome,
} from './application/outbox-admin.js';
export { RetentionPolicyService, retentionPolicyView } from './application/retention-policy.js';
export {
  TelemetryIngest,
  type TelemetryResult,
  type ClientRejectReason,
} from './application/telemetry-service.js';
export {
  createAnalyticsProjector,
  type AnalyticsProjectorOptions,
  type ProjectionOutcome,
} from './application/analytics-projector.js';
export { PROJECTIONS, type Projection, type ProjectionContext } from './application/analytics-projections.js';
export {
  RetentionPurger,
  retentionPurgeJob,
  scheduleRetention,
  ensureRetentionScheduled,
  RETENTION_DB_ROLE,
  RETENTION_STEPS,
  type PurgeRunResult,
  type PurgeStepResult,
  type RetentionJobOptions,
  type RetentionPurgerOptions,
} from './jobs/retention-purge.js';
export {
  SystemMonitor,
  type MonitorReport,
  type OrgLagReport,
  type QuotaReport,
  type StuckTask,
  type SystemMonitorOptions,
} from './jobs/system-monitor.js';
export { nextCronRun, parseDailyCron, retentionDedupeKey } from './domain/schedule.js';
export { TECHNICAL_RETENTION, retentionCutoffs, minusMonths } from './domain/retention-rules.js';
export { OUTBOX_LAG_RESOLVE_AFTER_MS, TASK_STUCK_THRESHOLD_MIN } from './domain/monitor-rules.js';

/** Worker job handlers of the module (apps/worker/src/handlers.ts). */
export function auditMonitoringJobs(opts: RetentionJobOptions = {}): JobHandler[] {
  return [retentionPurgeJob(opts)];
}

/** Domain-event projectors of the module: the AnalyticsProjector (15 §13.1). */
export function auditMonitoringProjectors(opts: AnalyticsProjectorOptions = {}): EventProjector[] {
  return [createAnalyticsProjector(opts)];
}

/** The worker's SystemMonitor loop (null when MONITOR_INTERVAL_S = 0). */
export function auditMonitoringMonitor(deps: {
  env: Env;
  db: Database;
  clock: Clock;
  logger: Logger;
}): SystemMonitor | null {
  if (deps.env.MONITOR_INTERVAL_S <= 0) return null;
  return new SystemMonitor(deps.db, deps.clock, deps.logger, {
    intervalMs: deps.env.MONITOR_INTERVAL_S * 1000,
    retentionCron: deps.env.RETENTION_PURGE_CRON_UTC,
  });
}
