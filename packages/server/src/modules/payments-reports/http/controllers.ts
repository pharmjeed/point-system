import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  Command,
  CurrentActor,
  CurrentTx,
  RequestId,
  RequirePermission,
  WithStatus,
  created,
} from '../../../http/decorators.js';
import { DATABASE } from '../../../http/tokens.js';
import type { PaymentInput } from '../domain/payment-rules.js';
import { CashHandoversService } from '../application/cash-handovers.js';
import { ExportsService } from '../application/exports.js';
import { PaymentsService } from '../application/payments.js';
import { ReportsService } from '../application/reports.js';
import { findEventInScope } from '../application/scope.js';
import { computeSettlement } from '../application/settlement.js';
import {
  CashHandoverBodySchema,
  DriversReportQuery,
  ExportBodySchema,
  MessagesReportQuery,
  PaymentInputPipe,
  PaymentsReportQuery,
  ReverseBodyPipe,
  WaiverBodyPipe,
  input,
  ticketIdParam,
  type ReverseBodySchema,
  type WaiverBodySchema,
} from './schemas.js';

/** Canon §9.4 — collection, waiver, reversal, cash handover, settlement (PNT-080 … PNT-082). */
@Controller('v1')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly cash: CashHandoversService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Post('tickets/:ticketId/payments')
  @RequirePermission('payment.record')
  @Command('POST /v1/tickets/{ticketId}/payments')
  async record(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) ticketId: string,
    @Body(new PaymentInputPipe()) body: PaymentInput,
  ) {
    return created(await this.payments.record(tx, actor, ticketId, body, rid));
  }

  @Post('tickets/:ticketId/payment-waiver')
  @RequirePermission('payment.waive')
  @Command('POST /v1/tickets/{ticketId}/payment-waiver')
  waive(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) ticketId: string,
    @Body(new WaiverBodyPipe()) body: z.infer<typeof WaiverBodySchema>,
  ) {
    return this.payments.waive(tx, actor, ticketId, body, rid);
  }

  @Post('payments/:paymentId/reverse')
  @RequirePermission('payment.reverse')
  @Command('POST /v1/payments/{paymentId}/reverse')
  reverse(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('paymentId') paymentId: string,
    @Body(new ReverseBodyPipe()) body: z.infer<typeof ReverseBodySchema>,
  ) {
    return this.payments.reverse(tx, actor, paymentId, body, rid);
  }

  @Post('cash-handovers')
  @RequirePermission('cash.handover_confirm')
  @Command('POST /v1/cash-handovers')
  async cashHandover(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Body(input(CashHandoverBodySchema)) body: z.infer<typeof CashHandoverBodySchema>,
  ) {
    return created(await this.cash.confirm(tx, actor, body, rid));
  }

  @Get('events/:eventId/settlement')
  @RequirePermission('report.read')
  settlement(@CurrentActor() actor: ActorContext, @Param('eventId') eventId: string) {
    // one REPEATABLE READ snapshot: the per-driver lines, the totals and the blockers agree (13 §11)
    return this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return computeSettlement(tx, await findEventInScope(tx, actor, eventId));
    });
  }
}

/** Canon §9.7 — reports (PNT-088). */
@Controller('v1/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('events/:eventId/summary')
  @RequirePermission('report.read')
  eventSummary(@CurrentActor() actor: ActorContext, @Param('eventId') eventId: string) {
    return this.reports.eventSummary(actor, eventId);
  }

  @Get('drivers')
  @RequirePermission('report.read')
  drivers(
    @CurrentActor() actor: ActorContext,
    @Query(input(DriversReportQuery)) q: z.infer<typeof DriversReportQuery>,
  ) {
    return this.reports.drivers(actor, q);
  }

  @Get('payments')
  @RequirePermission('report.read')
  payments(
    @CurrentActor() actor: ActorContext,
    @Query(input(PaymentsReportQuery)) q: z.infer<typeof PaymentsReportQuery>,
  ) {
    return this.reports.payments(actor, q);
  }

  @Get('messages')
  @RequirePermission('report.read')
  messages(
    @CurrentActor() actor: ActorContext,
    @Query(input(MessagesReportQuery)) q: z.infer<typeof MessagesReportQuery>,
  ) {
    return this.reports.messages(actor, q);
  }
}

/** Canon §9.7 — audited CSV exports (PNT-089). */
@Controller('v1/exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @RequirePermission('export.create')
  @Command('POST /v1/exports')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Body(input(ExportBodySchema)) body: z.infer<typeof ExportBodySchema>,
  ) {
    // 07: 202 Accepted — the file is built by job.export_generate
    return new WithStatus(202, await this.exports.request(tx, actor, body, rid));
  }

  @Get(':exportId')
  @RequirePermission('export.create')
  get(@CurrentActor() actor: ActorContext, @RequestId() rid: string, @Param('exportId') exportId: string) {
    return this.exports.get(actor, exportId, rid);
  }
}
