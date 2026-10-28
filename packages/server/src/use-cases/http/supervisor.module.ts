import { Module } from '@nestjs/common';
import { CustodyTransferUseCase } from '../custody-transfer.js';
import { InspectionExceptionUseCase } from '../inspection-exception.js';
import { SupervisorActionsController } from './supervisor-actions.controller.js';

/**
 * HTTP surface of the S6 supervisor backend: reads and commands on events and tickets that compose
 * tickets-custody, dispatch, incidents, media and whatsapp, so the module lives with the use-cases (04 §4.3
 * rule 2).
 */
@Module({
  controllers: [SupervisorActionsController],
  providers: [InspectionExceptionUseCase, CustodyTransferUseCase],
})
export class SupervisorHttpModule {}
