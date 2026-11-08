import { Body, Controller, Get, Post } from '@nestjs/common';
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
import { DutyService } from '../../modules/dispatch/index.js';
import { TicketQueries } from '../queries.js';
import { DutyBreakBody, DutyStartBody, EmptyBody } from './schemas.js';

/** Canon §9.1 — the driver's home and duty (PNT-024, PNT-065 snapshot). */
@Controller('v1/me')
export class DutyController {
  constructor(
    private readonly duty: DutyService,
    private readonly queries: TicketQueries,
  ) {}

  @Get('home')
  @RequirePermission('duty.self')
  home(@CurrentActor() actor: ActorContext) {
    return this.queries.home(actor);
  }

  @Post('duty/start')
  @RequirePermission('duty.self')
  @Command('POST /v1/me/duty/start')
  async start(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Body(zodBody(DutyStartBody)) body: z.infer<typeof DutyStartBody>,
  ) {
    return created(await this.duty.start(tx, actor, body, rid));
  }

  @Post('duty/break')
  @RequirePermission('duty.self')
  @Command('POST /v1/me/duty/break')
  setBreak(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Body(zodBody(DutyBreakBody)) body: z.infer<typeof DutyBreakBody>,
  ) {
    return this.duty.setBreak(tx, actor, body, rid);
  }

  @Post('duty/end')
  @RequirePermission('duty.self')
  @Command('POST /v1/me/duty/end')
  end(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Body(zodBody(EmptyBody)) _body: z.infer<typeof EmptyBody>,
  ) {
    return this.duty.end(tx, actor, rid);
  }
}
