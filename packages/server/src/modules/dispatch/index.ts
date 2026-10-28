// dispatch public surface (04 §4.2): duty sessions, tasks, offers, the dispatch pass and its timers.
import { registerDriverReleaseHook } from '../../core/hooks/driver-release.js';
import { dispatchDriverReleaseHook } from './application/driver-release.js';

// DEC-32 seam: identity-access (disable, transfer) and venues-events (shift close, forced end) call
// releaseDriverWork(); registered when the module is loaded (api and worker both import @point/server).
registerDriverReleaseHook(dispatchDriverReleaseHook);

export { compareIdle, idleCandidates, pickCandidate } from './domain/driver-state.js';
export type { PoolRow, TaskRow, OfferRow, DutyRow, QueueTask, PoolDriverRow } from './infra/rows.js';
export {
  ensurePoolLocked,
  holdsPool,
  lockOpenDemand,
  loadPoolDrivers,
  loadTriedSet,
  loadTicketCtx,
  driverStateOf,
  type DriverStateRow,
} from './infra/dispatch-repo.js';
export { dispatchSettings, type DispatchSettings } from './application/settings.js';
export { emitTaskEvent, emitOfferEvent, emitAvailability } from './application/events.js';
export {
  createSingleRound,
  revokeRound,
  revokeDriverSingleOffers,
  expireSingleRound,
  ensureDispatchSweep,
  requestDispatchPass,
  SWEEP_INTERVAL_MS,
} from './application/offers.js';
export {
  runDispatchPass,
  registerBroadcastPolicy,
  registerPassAdvisor,
  type PassReason,
  type PassResult,
  type BroadcastPolicy,
  type PassAdvisor,
} from './application/pass.js';
export {
  insertParkTask,
  insertRetrieveTask,
  settleDriverAfterTask,
  withdrawTask,
  type SettleOutcome,
} from './application/tasks.js';
export { DutyService, dutyItems, type DutyItem } from './application/duty-service.js';
export {
  releaseDriverWork as releaseDriverWorkImpl,
  dispatchDriverReleaseHook,
} from './application/driver-release.js';
export { dutySessionView, currentDriverState } from './application/views.js';
export { dispatchJobs, offerExpireHandler, dispatchPassHandler, dispatchSweepHandler } from './jobs/index.js';
