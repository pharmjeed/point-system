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
// S4 — dispatch operations, transfers, the customer's request entry point (PNT-052 … PNT-063, PNT-084, PNT-086)
export {
  ReassignTaskUseCase,
  ReleaseCustodyUseCase,
  CancelCycleUseCase,
  ReparkUseCase,
  type ReassignBody,
} from './dispatch-ops.js';
export {
  DriverTransfersUseCase,
  transferActivateHandler,
  transferWatchPlanner,
  registerTransferWatch,
  transferView,
  type TransferRow,
} from './transfers.js';
export { requestRetrievalForCustomer, type CustomerRequestResult } from './request-retrieval.js';
export { registerIncidentRecorder, type IncidentRecorder } from './hooks.js';
export { useCasesJobs } from './jobs.js';
