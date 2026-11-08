import { Module } from '@nestjs/common';
import { CustodyTransferUseCase } from '../custody-transfer.js';
import { InspectionExceptionUseCase } from '../inspection-exception.js';
import { SupervisorActionsController } from './supervisor-actions.controller.js';
import { OperationsBoardQuery } from '../operations-board.js';
import { OperationsBoardController } from './operations-board.controller.js';
import { RevealPhoneUseCase } from '../reveal-phone.js';
import { RevealPhoneController } from './reveal-phone.controller.js';
import { ManualReconcileUseCase } from '../manual-reconcile.js';
import { ManualReconcileController } from './manual-reconcile.controller.js';
import { MediaHttpModule, MediaReadUrlQuery } from '../../modules/media/index.js';
import { TicketTimelineQuery } from '../ticket-timeline.js';
import { TicketTimelineController } from './ticket-timeline.controller.js';

/**
 * HTTP surface of the S6 supervisor backend: reads and commands on events and tickets that compose
 * tickets-custody, dispatch, incidents, media and whatsapp, so the module lives with the use-cases (04 §4.3
 * rule 2). The media module's storage signs the timeline photo URLs.
 */
@Module({
  imports: [MediaHttpModule],
  controllers: [
    SupervisorActionsController,
    OperationsBoardController,
    RevealPhoneController,
    ManualReconcileController,
    TicketTimelineController,
  ],
  providers: [
    InspectionExceptionUseCase,
    CustodyTransferUseCase,
    OperationsBoardQuery,
    RevealPhoneUseCase,
    ManualReconcileUseCase,
    MediaReadUrlQuery,
    TicketTimelineQuery,
  ],
})
export class SupervisorHttpModule {}
