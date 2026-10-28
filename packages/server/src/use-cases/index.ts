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

// S3 customer flows (PNT-043 … PNT-051, PNT-078): installed at load (button press, direct link at submit)
export { installCustomerFlows } from './customer-flows/install.js';
export { handleButtonPress } from './customer-flows/button-press.js';
