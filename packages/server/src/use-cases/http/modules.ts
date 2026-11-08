import { Module, type OnModuleInit } from '@nestjs/common';
import { DutyService, registerDispatchRealtime } from '../../modules/dispatch/index.js';
import { IntakeService } from '../../modules/tickets-custody/index.js';
import { AcceptOfferUseCase } from '../accept-offer.js';
import { CompleteParkingUseCase } from '../complete-parking.js';
import {
  CancelCycleUseCase,
  ReassignTaskUseCase,
  ReleaseCustodyUseCase,
  ReparkUseCase,
} from '../dispatch-ops.js';
import { DiscardDraftUseCase, VoidTicketUseCase } from '../discard-void.js';
import { HandoverUseCase } from '../handover.js';
import { IntakePassUseCase } from '../intake-pass.js';
import { MovementUseCase } from '../movement.js';
import { TicketQueries } from '../queries.js';
import { RequestRetrievalUseCase } from '../request-retrieval.js';
import { StartIntakeUseCase } from '../start-intake.js';
import { SubmitIntakeUseCase } from '../submit-intake.js';
import { DriverTransfersUseCase, registerTransferWatch } from '../transfers.js';
import {
  DriverTransfersController,
  DutySessionsController,
  RetrievalCyclesController,
  TaskOpsController,
  TicketReparkController,
} from './dispatch-ops.controller.js';
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
    IntakePassUseCase,
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

/**
 * HTTP surface of dispatch: duty, the driver's home snapshot, the atomic accept (canon §9.1, §9.3) and the S4
 * operations — reassign, release-custody, field cancel, repark, forced duty end and driver transfers. The api
 * process registers the dispatch realtime planner (DEC-48) and the blocked-transfer watch here; the worker does it
 * through dispatchJobs() / useCasesJobs().
 */
@Module({
  controllers: [
    DutyController,
    TaskOffersController,
    TaskOpsController,
    RetrievalCyclesController,
    TicketReparkController,
    DutySessionsController,
    DriverTransfersController,
  ],
  providers: [
    DutyService,
    AcceptOfferUseCase,
    TicketQueries,
    ReassignTaskUseCase,
    ReleaseCustodyUseCase,
    CancelCycleUseCase,
    ReparkUseCase,
    DriverTransfersUseCase,
  ],
})
export class DispatchHttpModule implements OnModuleInit {
  onModuleInit(): void {
    registerDispatchRealtime();
    registerTransferWatch();
  }
}
