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
// PNT-080: the handover collects through the InlinePaymentHook (registered when this module loads)
export { handoverPaymentHook } from './inline-payment.js';
// PNT-087: reconciliation + close (04 §4.4)
export { EventCloseHttpModule } from './http/event-close.controller.js';
export { CloseEventUseCase, EventCloseQueries, type CloseEventBody } from './close-event.js';
export {
  registerCustomerLinkingHook,
  registerClaimCodeHook,
  registerInlinePaymentHook,
  type CustomerLinkingHook,
  type ClaimCodeHook,
  type InlinePaymentHook,
} from './hooks.js';
