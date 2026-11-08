import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import type { Tx } from '../../core/db/tx.js';
import {
  Command,
  CurrentActor,
  CurrentTx,
  RequestId,
  RequirePermission,
  created,
} from '../../http/decorators.js';
import { zodBody } from '../../http/zod-pipe.js';
import { IntakeService } from '../../modules/tickets-custody/index.js';
import { DiscardDraftUseCase, VoidTicketUseCase } from '../discard-void.js';
import { HandoverUseCase } from '../handover.js';
import { IntakePassUseCase } from '../intake-pass.js';
import { TicketQueries } from '../queries.js';
import { RequestRetrievalUseCase } from '../request-retrieval.js';
import { StartIntakeUseCase } from '../start-intake.js';
import { SubmitIntakeUseCase } from '../submit-intake.js';
import { reasonBody, ticketIdParam } from './pipes.js';
import {
  HandoverBody,
  IntakePassBody,
  ListTicketsQuery,
  PatchIntakeBody,
  ReasonOnlyBody,
  StartIntakeBody,
  SubmitIntakeBody,
  VersionOnlyBody,
  VoidBody,
} from './schemas.js';

/** Canon §9.2 / §9.3 — tickets: intake, reads, retrieval on behalf, handover (PNT-025 … PNT-034). */
@Controller('v1/tickets')
export class TicketsController {
  constructor(
    private readonly startIntake: StartIntakeUseCase,
    private readonly intakePass: IntakePassUseCase,
    private readonly intake: IntakeService,
    private readonly submitIntake: SubmitIntakeUseCase,
    private readonly discardDraft: DiscardDraftUseCase,
    private readonly voidTicket: VoidTicketUseCase,
    private readonly requestRetrieval: RequestRetrievalUseCase,
    private readonly handover: HandoverUseCase,
    private readonly queries: TicketQueries,
  ) {}

  @Post()
  @RequirePermission('ticket.intake')
  @Command('POST /v1/tickets')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Body(zodBody(StartIntakeBody)) body: z.infer<typeof StartIntakeBody>,
  ) {
    return created(await this.startIntake.execute(tx, actor, body, rid));
  }

  /** O-01 (V2-013, DEC-500): the customer's entry pass scanned in D-05; 200 for a draft, 201 for a new ticket. */
  @Post('intake-pass')
  @RequirePermission('ticket.intake')
  @Command('POST /v1/tickets/intake-pass')
  async byPass(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Body(zodBody(IntakePassBody)) body: z.infer<typeof IntakePassBody>,
  ) {
    const result = await this.intakePass.execute(tx, actor, body, rid);
    return 'task' in result ? created(result) : result;
  }

  @Get()
  @RequirePermission('ticket.read_minimal')
  list(
    @CurrentActor() actor: ActorContext,
    @Query(zodBody(ListTicketsQuery)) q: z.infer<typeof ListTicketsQuery>,
  ) {
    return this.queries.list(actor, q);
  }

  @Get(':ticketId')
  @RequirePermission('ticket.read_minimal')
  detail(@CurrentActor() actor: ActorContext, @Param('ticketId', ticketIdParam) id: string) {
    return this.queries.detail(actor, id);
  }

  @Patch(':ticketId/intake')
  @RequirePermission('ticket.intake')
  @Command('PATCH /v1/tickets/{ticketId}/intake')
  patchIntake(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(zodBody(PatchIntakeBody)) body: z.infer<typeof PatchIntakeBody>,
  ) {
    return this.intake.update(tx, actor, id, body, rid);
  }

  @Post(':ticketId/submit-intake')
  @RequirePermission('ticket.intake')
  @Command('POST /v1/tickets/{ticketId}/submit-intake')
  submit(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(zodBody(SubmitIntakeBody)) body: z.infer<typeof SubmitIntakeBody>,
  ) {
    return this.submitIntake.execute(tx, actor, id, body, rid);
  }

  @Post(':ticketId/discard-draft')
  @RequirePermission('ticket.discard_empty_draft')
  @Command('POST /v1/tickets/{ticketId}/discard-draft')
  discard(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(zodBody(VersionOnlyBody)) body: z.infer<typeof VersionOnlyBody>,
  ) {
    return this.discardDraft.execute(tx, actor, id, body, rid);
  }

  @Post(':ticketId/void')
  @RequirePermission('ticket.void')
  @Command('POST /v1/tickets/{ticketId}/void')
  void(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(reasonBody(VoidBody)) body: z.infer<typeof VoidBody>,
  ) {
    return this.voidTicket.execute(tx, actor, id, body, rid);
  }

  @Post(':ticketId/retrievals')
  @RequirePermission('retrieval.request_on_behalf')
  @Command('POST /v1/tickets/{ticketId}/retrievals')
  async retrieval(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(reasonBody(ReasonOnlyBody)) body: z.infer<typeof ReasonOnlyBody>,
  ) {
    return created(await this.requestRetrieval.execute(tx, actor, id, body, rid));
  }

  @Post(':ticketId/handover')
  @RequirePermission('handover.verify')
  @Command('POST /v1/tickets/{ticketId}/handover')
  doHandover(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(zodBody(HandoverBody)) body: z.infer<typeof HandoverBody>,
  ) {
    return this.handover.execute(tx, actor, id, body, rid);
  }
}
