import { Body, Controller, Header, Param, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import type { Tx } from '../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../http/decorators.js';
import { RevealPhoneUseCase } from '../reveal-phone.js';
import { reasonBody, ticketIdParam } from './pipes.js';
import { RevealPhoneBody } from './supervisor-schemas.js';

/** Canon §9.2 `POST /v1/tickets/{ticketId}/reveal-phone` — the audited full number (PNT-077, S-03). */
@Controller('v1/tickets')
export class RevealPhoneController {
  constructor(private readonly revealPhone: RevealPhoneUseCase) {}

  @Post(':ticketId/reveal-phone')
  @RequirePermission('ticket.reveal_phone')
  @Command('POST /v1/tickets/{ticketId}/reveal-phone')
  @Header('Cache-Control', 'private, no-store')
  reveal(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(reasonBody(RevealPhoneBody)) body: z.infer<typeof RevealPhoneBody>,
  ) {
    return this.revealPhone.execute(tx, actor, id, body, rid);
  }
}
