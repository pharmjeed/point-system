import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import { AppError } from '../../core/errors/app-error.js';
import { CurrentActor, RequirePermission } from '../../http/decorators.js';
import { OperationsBoardQuery } from '../operations-board.js';

/** Canon §9.5 `GET /v1/events/{eventId}/operations` — the live operations board (PNT-074, S-02). */
@Controller('v1/events')
export class OperationsBoardController {
  constructor(private readonly board: OperationsBoardQuery) {}

  @Get(':eventId/operations')
  @RequirePermission('alert.read')
  operations(
    @CurrentActor() actor: ActorContext,
    @Param(
      'eventId',
      new ParseUUIDPipe({
        exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'event' }),
      }),
    )
    eventId: string,
  ) {
    return this.board.execute(actor, eventId);
  }
}
