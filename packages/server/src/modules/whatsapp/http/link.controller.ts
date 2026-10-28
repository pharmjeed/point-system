import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../../http/decorators.js';
import { zodBody } from '../../../http/zod-pipe.js';
import {
  WhatsappLinkBody,
  WhatsappLinkCommands,
  WhatsappLinkConfirmBody,
} from '../application/link-commands.js';

const ticketIdParam = new ParseUUIDPipe({ exceptionFactory: () => new AppError('TICKET_NOT_FOUND') });

/** Canon §9.2 — linking a ticket to the customer's conversation (PNT-043, PNT-044; 12 §7.1–§7.2). */
@Controller('v1/tickets')
export class WhatsappLinkController {
  constructor(private readonly commands: WhatsappLinkCommands) {}

  @Post(':ticketId/whatsapp-link')
  @RequirePermission('wa.link')
  @Command('POST /v1/tickets/{ticketId}/whatsapp-link')
  link(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(zodBody(WhatsappLinkBody)) body: WhatsappLinkBody,
  ) {
    return this.commands.link(tx, actor, id, body, rid);
  }

  @Post(':ticketId/whatsapp-link/confirm')
  @RequirePermission('wa.link')
  @Command('POST /v1/tickets/{ticketId}/whatsapp-link/confirm')
  confirm(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(zodBody(WhatsappLinkConfirmBody)) body: WhatsappLinkConfirmBody,
  ) {
    return this.commands.confirm(tx, actor, id, body, rid);
  }
}
