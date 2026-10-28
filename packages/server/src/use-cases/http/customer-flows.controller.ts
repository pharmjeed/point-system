import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import type { Tx } from '../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../http/decorators.js';
import { ResendHandoverCodeUseCase } from '../customer-flows/handover-codes.js';
import {
  ChangeCustomerPhonePipe,
  ChangeCustomerPhoneUseCase,
  type ChangeCustomerPhoneBody,
} from '../customer-flows/linking.js';
import { ticketIdParam } from './pipes.js';

/** Canon §9.2 / §9.3 — the customer side of a ticket (S3): phone change (PNT-049), handover code resend (PNT-047). */
@Controller('v1/tickets')
export class CustomerFlowsController {
  constructor(
    private readonly changePhone: ChangeCustomerPhoneUseCase,
    private readonly resend: ResendHandoverCodeUseCase,
  ) {}

  @Patch(':ticketId/customer-phone')
  @RequirePermission('ticket.change_phone')
  @Command('PATCH /v1/tickets/{ticketId}/customer-phone')
  customerPhone(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(new ChangeCustomerPhonePipe()) body: ChangeCustomerPhoneBody,
  ) {
    return this.changePhone.execute(tx, actor, id, body, rid);
  }

  @Post(':ticketId/handover-code/resend')
  @RequirePermission('handover.resend_code')
  @Command('POST /v1/tickets/{ticketId}/handover-code/resend')
  resendCode(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
  ) {
    return this.resend.execute(tx, actor, id, rid);
  }
}
