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
export {
  requestRetrievalForCustomer,
  applyCustomerRequest,
  type CustomerRequestResult,
} from './request-retrieval.js';
export { registerIncidentRecorder, type IncidentRecorder } from './hooks.js';
export { useCasesJobs } from './jobs.js';

// S3 customer flows (PNT-043 … PNT-051, PNT-078): installed at load (button press, direct link at submit)
export { installCustomerFlows } from './customer-flows/install.js';
export { CustomerFlowsHttpModule } from './http/customer-flows.module.js';
export { handleButtonPress } from './customer-flows/button-press.js';
export { claimCodeHookFor, claimCodeSecrets } from './customer-flows/handover-codes.js';
export { identityMethods, claimedChecks } from './customer-flows/handover-exception.js';

// S6 supervisor backend (PNT-074 … PNT-085)
export { SupervisorHttpModule } from './http/supervisor.module.js';
export { maskCustomerText, waMessageView, custodyEventView, paymentView } from './supervisor-views.js';
export { InspectionExceptionUseCase } from './inspection-exception.js';
export { CustodyTransferUseCase, type CustodyTransferBody } from './custody-transfer.js';
export { OperationsBoardQuery, type BoardBadge } from './operations-board.js';
export { RevealPhoneUseCase } from './reveal-phone.js';
export {
  ManualReconcileUseCase,
  normalizePosReference,
  type ManualReconcileBody,
} from './manual-reconcile.js';
export { TicketTimelineQuery } from './ticket-timeline.js';
