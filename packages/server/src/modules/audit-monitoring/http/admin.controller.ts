import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { retentionPolicyEditableSchema, type RetentionPolicyEditable } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../../http/decorators.js';
import { CLOCK, DATABASE } from '../../../http/tokens.js';
import { zodBody } from '../../../http/zod-pipe.js';
import { AuditQuery } from '../application/audit-query.js';
import { OutboxAdmin } from '../application/outbox-admin.js';
import { RetentionPolicyService } from '../application/retention-policy.js';
import { AuditLogQuery, OutboxQuery } from './schemas.js';

const outboxIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'outbox_event' }),
});

/** Canon §9.7 — audit log, outbox administration, retention policy (PNT-091, PNT-092). */
@Controller('v1/admin')
export class AuditMonitoringAdminController {
  constructor(
    private readonly auditLog: AuditQuery,
    private readonly outbox: OutboxAdmin,
    private readonly retention: RetentionPolicyService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('audit-log')
  @RequirePermission('audit.read')
  listAuditLog(
    @CurrentActor() actor: ActorContext,
    @Query(zodBody(AuditLogQuery)) q: AuditLogQuery,
    @RequestId() requestId: string,
  ) {
    return this.auditLog.list(actor, q, requestId);
  }

  @Get('outbox')
  @RequirePermission('outbox.manage')
  listOutbox(@CurrentActor() actor: ActorContext, @Query(zodBody(OutboxQuery)) q: OutboxQuery) {
    return this.outbox.list(actor, q, this.clock.now());
  }

  @Post('outbox/:outboxId/retry')
  @RequirePermission('outbox.manage')
  @Command('POST /v1/admin/outbox/{outboxId}/retry')
  retryOutbox(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Param('outboxId', outboxIdParam) outboxId: string,
    @RequestId() requestId: string,
  ) {
    return this.outbox.retry(tx, actor, outboxId, requestId);
  }

  @Get('retention-policy')
  @RequirePermission('audit.read')
  getRetentionPolicy(@CurrentActor() actor: ActorContext) {
    return this.retention.get(this.db, actor);
  }

  @Put('retention-policy')
  @RequirePermission('retention.manage')
  @Command('PUT /v1/admin/retention-policy')
  putRetentionPolicy(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @Body(zodBody(retentionPolicyEditableSchema)) body: RetentionPolicyEditable,
    @RequestId() requestId: string,
  ) {
    return this.retention.put(tx, actor, body, requestId);
  }
}
