import type { JobHandler } from '../core/outbox/dispatcher.js';
import { registerDispatchRealtime } from '../modules/dispatch/index.js';
import { registerTransferWatch, transferActivateHandler } from './transfers.js';

/**
 * Worker handlers of the cross-module use-cases (04 §4.2: `job.transfer_activate` runs the ActivateTransfer use
 * case). Registers the planners their transactions need: the blocked-transfer watch and the dispatch realtime
 * messages (idempotent with dispatchJobs()).
 */
export function useCasesJobs(): JobHandler[] {
  registerDispatchRealtime();
  registerTransferWatch();
  return [transferActivateHandler];
}
