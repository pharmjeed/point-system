import { Module } from '@nestjs/common';
import { DutyService } from '../../modules/dispatch/index.js';
import { IntakeService } from '../../modules/tickets-custody/index.js';
import { AcceptOfferUseCase } from '../accept-offer.js';
import { CompleteParkingUseCase } from '../complete-parking.js';
import { DiscardDraftUseCase, VoidTicketUseCase } from '../discard-void.js';
import { HandoverUseCase } from '../handover.js';
import { MovementUseCase } from '../movement.js';
import { TicketQueries } from '../queries.js';
import { RequestRetrievalUseCase } from '../request-retrieval.js';
import { StartIntakeUseCase } from '../start-intake.js';
import { SubmitIntakeUseCase } from '../submit-intake.js';
import { DutyController } from './duty.controller.js';
import { TaskOffersController, TasksController } from './tasks.controller.js';
import { TicketsController } from './tickets.controller.js';

/**
 * HTTP surface of tickets-custody (canon §9.2, §9.3). Its controllers call use-cases that compose
 * tickets-custody with dispatch, so the Nest module lives with the use-cases (04 §4.3 rule 2).
 */
@Module({
  controllers: [TicketsController, TasksController],
  providers: [
    IntakeService,
    StartIntakeUseCase,
    SubmitIntakeUseCase,
    DiscardDraftUseCase,
    VoidTicketUseCase,
    RequestRetrievalUseCase,
    HandoverUseCase,
    CompleteParkingUseCase,
    MovementUseCase,
    TicketQueries,
  ],
})
export class TicketsCustodyHttpModule {}

/** HTTP surface of dispatch: duty, the driver's home snapshot and the atomic accept (canon §9.1, §9.3). */
@Module({
  controllers: [DutyController, TaskOffersController],
  providers: [DutyService, AcceptOfferUseCase, TicketQueries],
})
export class DispatchHttpModule {}
