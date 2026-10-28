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
import { DutyService } from '../../modules/dispatch/index.js';
import {
  CancelCycleUseCase,
  ReassignTaskUseCase,
  ReleaseCustodyUseCase,
  ReparkUseCase,
} from '../dispatch-ops.js';
import { DriverTransfersUseCase } from '../transfers.js';
import {
  cycleIdParam,
  driverIdParam,
  reasonBody,
  sessionIdParam,
  taskIdParam,
  ticketIdParam,
  transferIdParam,
} from './pipes.js';
import { ReassignBody, ReasonOnlyBody, ReleaseCustodyBody, ReparkBody, TransferBody } from './schemas.js';

/** Canon §9.3 — supervisor operations on tasks before the movement (PNT-058; 10 §9.1, §9.2). */
@Controller('v1/tasks')
export class TaskOpsController {
  constructor(
    private readonly reassignTask: ReassignTaskUseCase,
    private readonly releaseCustody: ReleaseCustodyUseCase,
  ) {}

  @Post(':taskId/reassign')
  @RequirePermission('task.reassign')
  @Command('POST /v1/tasks/{taskId}/reassign')
  reassign(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('taskId', taskIdParam) id: string,
    @Body(reasonBody(ReassignBody)) body: z.infer<typeof ReassignBody>,
  ) {
    return this.reassignTask.execute(tx, actor, id, body, rid);
  }

  @Post(':taskId/release-custody')
  @RequirePermission('task.release_custody')
  @Command('POST /v1/tasks/{taskId}/release-custody')
  release(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('taskId', taskIdParam) id: string,
    @Body(reasonBody(ReleaseCustodyBody)) body: z.infer<typeof ReleaseCustodyBody>,
  ) {
    return this.releaseCustody.execute(tx, actor, id, body, rid);
  }
}

/** Canon §9.3 — field cancellation of a retrieval request (PNT-059; 10 §9.3, DEC-30). */
@Controller('v1/retrieval-cycles')
export class RetrievalCyclesController {
  constructor(private readonly cancelCycle: CancelCycleUseCase) {}

  @Post(':cycleId/cancel')
  @RequirePermission('retrieval.cancel')
  @Command('POST /v1/retrieval-cycles/{cycleId}/cancel')
  cancel(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('cycleId', cycleIdParam) id: string,
    @Body(reasonBody(ReasonOnlyBody)) body: z.infer<typeof ReasonOnlyBody>,
  ) {
    return this.cancelCycle.execute(tx, actor, id, body, rid);
  }
}

/** Canon §9.3 — repark for customer absence (PNT-061; 10 §9.4, TT-20). */
@Controller('v1/tickets')
export class TicketReparkController {
  constructor(private readonly repark: ReparkUseCase) {}

  @Post(':ticketId/repark')
  @RequirePermission('ticket.repark')
  @Command('POST /v1/tickets/{ticketId}/repark')
  reparkTicket(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('ticketId', ticketIdParam) id: string,
    @Body(reasonBody(ReparkBody)) body: z.infer<typeof ReparkBody>,
  ) {
    return this.repark.execute(tx, actor, id, body, rid);
  }
}

/** Canon §9.6 — forced end of a driver's duty (PNT-084; 10 §9.5, DEC-32). */
@Controller('v1/duty-sessions')
export class DutySessionsController {
  constructor(private readonly duty: DutyService) {}

  @Post(':sessionId/force-end')
  @RequirePermission('duty.force_end')
  @Command('POST /v1/duty-sessions/{sessionId}/force-end')
  forceEnd(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('sessionId', sessionIdParam) id: string,
    @Body(reasonBody(ReasonOnlyBody)) body: z.infer<typeof ReasonOnlyBody>,
  ) {
    return this.duty.forceEnd(tx, actor, id, body, rid);
  }
}

/** Canon §9.6 — driver transfers between venues (PNT-086; 10 §9.7). */
@Controller('v1')
export class DriverTransfersController {
  constructor(private readonly transfers: DriverTransfersUseCase) {}

  @Post('drivers/:driverId/transfers')
  @RequirePermission('driver.transfer')
  @Command('POST /v1/drivers/{driverId}/transfers')
  async create(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('driverId', driverIdParam) id: string,
    @Body(reasonBody(TransferBody)) body: z.infer<typeof TransferBody>,
  ) {
    return created(await this.transfers.create(tx, actor, id, body, rid));
  }

  @Post('transfers/:transferId/cancel')
  @RequirePermission('driver.transfer')
  @Command('POST /v1/transfers/{transferId}/cancel')
  cancel(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('transferId', transferIdParam) id: string,
    @Body(reasonBody(ReasonOnlyBody)) body: z.infer<typeof ReasonOnlyBody>,
  ) {
    return this.transfers.cancel(tx, actor, id, body, rid);
  }
}
