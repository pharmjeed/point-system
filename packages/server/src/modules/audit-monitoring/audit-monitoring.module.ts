import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import { CLOCK, DATABASE, ENV, LOGGER } from '../../http/tokens.js';
import { AuditQuery } from './application/audit-query.js';
import { OutboxAdmin } from './application/outbox-admin.js';
import { RetentionPolicyService } from './application/retention-policy.js';
import { TelemetryIngest } from './application/telemetry-service.js';
import { AuditMonitoringAdminController } from './http/admin.controller.js';
import { TelemetryController } from './http/telemetry.controller.js';
import { SystemMonitor } from './jobs/system-monitor.js';

/**
 * The api also runs the SystemMonitor: when the worker is stopped, nobody in the worker can notice its own
 * absence (PNT-094 AC, 17 §6 "توقف العامل دقيقتين"). Off in tests (they call `tick()` themselves) and when
 * MONITOR_INTERVAL_S = 0.
 */
@Injectable()
export class ApiSystemMonitor implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly monitor: SystemMonitor | null;
  constructor(
    @Inject(DATABASE) db: Database,
    @Inject(CLOCK) clock: Clock,
    @Inject(LOGGER) logger: Logger,
    @Inject(ENV) env: Env,
  ) {
    this.monitor =
      env.MONITOR_INTERVAL_S > 0 && env.NODE_ENV !== 'test'
        ? new SystemMonitor(db, clock, logger, {
            intervalMs: env.MONITOR_INTERVAL_S * 1000,
            retentionCron: env.RETENTION_PURGE_CRON_UTC,
          })
        : null;
  }
  onApplicationBootstrap() {
    this.monitor?.start();
  }
  async onApplicationShutdown() {
    await this.monitor?.stop();
  }
}

/** audit-monitoring (04 §4.2 item 9): audit viewer, outbox admin, retention policy, telemetry. */
@Module({
  controllers: [AuditMonitoringAdminController, TelemetryController],
  providers: [AuditQuery, OutboxAdmin, RetentionPolicyService, TelemetryIngest, ApiSystemMonitor],
  exports: [AuditQuery, OutboxAdmin, RetentionPolicyService, TelemetryIngest],
})
export class AuditMonitoringHttpModule {}
