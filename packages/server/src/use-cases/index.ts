// Cross-module use-cases (04 §4.4): they own the transaction and compose tickets-custody with dispatch.
export { TicketsCustodyHttpModule, DispatchHttpModule } from './http/modules.js';
export { StartIntakeUseCase, type StartIntakeBody } from './start-intake.js';
export { SubmitIntakeUseCase } from './submit-intake.js';
export { DiscardDraftUseCase, VoidTicketUseCase } from './discard-void.js';
export { CompleteParkingUseCase, type CompleteParkingBody } from './complete-parking.js';
export { RequestRetrievalUseCase, openRetrievalCycle } from './request-retrieval.js';
export { AcceptOfferUseCase } from './accept-offer.js';
export { MovementUseCase } from './movement.js';
export { HandoverUseCase, type HandoverBody } from './handover.js';
export { TicketQueries, type ListTicketsQuery } from './queries.js';
export { loadTaskCard, driverStateResult } from './views.js';
export {
  registerCustomerLinkingHook,
  registerClaimCodeHook,
  registerInlinePaymentHook,
  type CustomerLinkingHook,
  type ClaimCodeHook,
  type InlinePaymentHook,
} from './hooks.js';
// S6 supervisor backend (PNT-074 … PNT-085)
export { SupervisorHttpModule } from './http/supervisor.module.js';
export { maskCustomerText, waMessageView, custodyEventView, paymentView } from './supervisor-views.js';
export { InspectionExceptionUseCase } from './inspection-exception.js';
export { CustodyTransferUseCase, type CustodyTransferBody } from './custody-transfer.js';
export { OperationsBoardQuery, type BoardBadge } from './operations-board.js';
export { RevealPhoneUseCase } from './reveal-phone.js';
