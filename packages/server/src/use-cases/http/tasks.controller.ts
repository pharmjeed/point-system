import { Body, Controller, Param, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import type { Tx } from '../../core/db/tx.js';
import { Command, CurrentActor, CurrentTx, RequestId, RequirePermission } from '../../http/decorators.js';
import { zodBody } from '../../http/zod-pipe.js';
import { AcceptOfferUseCase } from '../accept-offer.js';
import { CompleteParkingUseCase } from '../complete-parking.js';
import { MovementUseCase } from '../movement.js';
import { offerIdParam, taskIdParam } from './pipes.js';
import { CompleteParkingBody, EmptyBody, KeyPickupBody, VersionOnlyBody } from './schemas.js';

/** Canon §9.3 — task execution (PNT-030, PNT-033). */
@Controller('v1/tasks')
export class TasksController {
  constructor(
    private readonly completeParking: CompleteParkingUseCase,
    private readonly movement: MovementUseCase,
  ) {}

  @Post(':taskId/complete-parking')
  @RequirePermission('task.execute')
  @Command('POST /v1/tasks/{taskId}/complete-parking')
  complete(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('taskId', taskIdParam) id: string,
    @Body(zodBody(CompleteParkingBody)) body: z.infer<typeof CompleteParkingBody>,
  ) {
    return this.completeParking.execute(tx, actor, id, body, rid);
  }

  @Post(':taskId/key-pickup')
  @RequirePermission('task.execute')
  @Command('POST /v1/tasks/{taskId}/key-pickup')
  keyPickup(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('taskId', taskIdParam) id: string,
    @Body(zodBody(KeyPickupBody)) body: z.infer<typeof KeyPickupBody>,
  ) {
    return this.movement.keyPickup(tx, actor, id, body, rid);
  }

  @Post(':taskId/start-retrieval')
  @RequirePermission('task.execute')
  @Command('POST /v1/tasks/{taskId}/start-retrieval')
  start(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('taskId', taskIdParam) id: string,
    @Body(zodBody(VersionOnlyBody)) body: z.infer<typeof VersionOnlyBody>,
  ) {
    return this.movement.startRetrieval(tx, actor, id, body, rid);
  }

  @Post(':taskId/ready')
  @RequirePermission('task.execute')
  @Command('POST /v1/tasks/{taskId}/ready')
  ready(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('taskId', taskIdParam) id: string,
    @Body(zodBody(VersionOnlyBody)) body: z.infer<typeof VersionOnlyBody>,
  ) {
    return this.movement.markReady(tx, actor, id, body, rid);
  }
}

/** Canon §9.3 — atomic accept (PNT-032; 10 §5). */
@Controller('v1/task-offers')
export class TaskOffersController {
  constructor(private readonly accept: AcceptOfferUseCase) {}

  @Post(':offerId/accept')
  @RequirePermission('offer.accept')
  @Command('POST /v1/task-offers/{offerId}/accept')
  acceptOffer(
    @CurrentTx() tx: Tx,
    @CurrentActor() actor: ActorContext,
    @RequestId() rid: string,
    @Param('offerId', offerIdParam) id: string,
    @Body(zodBody(EmptyBody)) _body: z.infer<typeof EmptyBody>,
  ) {
    return this.accept.execute(tx, actor, id, rid);
  }
}
