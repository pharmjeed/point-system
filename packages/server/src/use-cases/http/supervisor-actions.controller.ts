import { Body, Controller, Param, Post } from '@nestjs/common';
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
import { CustodyTransferUseCase } from '../custody-transfer.js';
import { InspectionExceptionUseCase } from '../inspection-exception.js';
import { reasonBody, ticketIdParam } from './pipes.js';
import { CustodyTransferBody, InspectionExceptionBody } from './supervisor-schemas.js';

/** Canon §9.2 / §9.3 supervisor actions (PNT-079, S-03): inspection exception and official custody transfer. */
@Controller('v1/tickets')
export class SupervisorActionsController {
  constructor(
    private readonly inspectionException: InspectionExceptionUseCase,
    private readonly custodyTransfer: CustodyTransferUseCase,
  ) {}

  @Post(':ticketId/inspection-exception')
  @RequirePermission('ticket.inspection_exception')
  @Command('POST /v1/tickets/{ticketId}/inspection-exception')
  approveInspectionException(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(reasonBody(InspectionExceptionBody)) body: z.infer<typeof InspectionExceptionBody>,
  ) {
    return this.inspectionException.execute(tx, actor, id, body, rid);
  }

  @Post(':ticketId/custody-transfers')
  @RequirePermission('ticket.custody_transfer')
  @Command('POST /v1/tickets/{ticketId}/custody-transfers')
  async transferCustody(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(reasonBody(CustodyTransferBody)) body: z.infer<typeof CustodyTransferBody>,
  ) {
    return created(await this.custodyTransfer.execute(tx, actor, id, body, rid));
  }
}
