// tickets-custody public surface (04 §4.2). Never imports dispatch (04 §4.3 rule 2).
export {
  normalizePlate,
  plateView,
  normalizeTag,
  latinDigits,
  PLATE_LETTER_MAP,
  type PlateInput,
  type NormalizedPlate,
} from './domain/plate.js';
export { missingIntakeFields, draftFieldsPresent, hasPlate, type IntakeSnapshot } from './domain/intake.js';
export {
  OPEN_TICKET_STATUSES,
  CLOSED_TICKET_STATUSES,
  isClosedTicket,
  type TicketRow,
  type CycleRow,
} from './infra/rows.js';
export {
  emitForTicket,
  ticketRef,
  userActor,
  systemActor,
  type TicketCtx,
  type EventActor,
} from './application/events.js';
export { moveCustody, moveBoth, type Holder } from './application/custody.js';
export { invalidTransition, versionConflict, checkVersion } from './application/errors.js';
export {
  loadTicketDetail,
  loadTicketSummary,
  ticketSummary,
  taskView,
  loadTaskView,
  cycleView,
  userRef,
  TASK_SELECT,
  SUMMARY_SELECT,
  type Queryable as TicketQueryable,
  type Viewer as TicketViewer,
  type TaskReadRow,
  type TicketSummaryRow,
} from './application/views.js';
export {
  IntakeService,
  findTicketInScope,
  assertCreator,
  revokeLiveLinkCodes,
  type IntakePatch,
} from './application/intake-service.js';
export { loadTaskCard, type TaskCard } from './application/task-card.js';
export { ticketsCustodyJobs } from './jobs/index.js';
export {
  READY_UNCOLLECTED_JOB,
  readyUncollectedHandler,
  scheduleReadyUncollectedCheck,
} from './jobs/ready-uncollected.js';
// handover codes (PNT-047; 11 §5.1, DEC-38)
export {
  CLAIM_CODE_DIGITS,
  claimCodeHash,
  issueClaimCode,
  verifyClaimCode,
  resendClaimCode,
  revokeClaimCodes,
  lockLiveClaimCode,
  latestClaimCode,
  claimCodeState,
  loadClaimCodeState,
  claimCodeExpireHandler,
  type ClaimCodeRow,
  type ClaimCodeSecrets,
  type ClaimCodeState,
} from './application/claim-codes.js';
export {
  registerCustodyTicketUpdatePublisher,
  type CustodyTicketUpdatePublisher,
} from './application/ticket-update-seam.js';
