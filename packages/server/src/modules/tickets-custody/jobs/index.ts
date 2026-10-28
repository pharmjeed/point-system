import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { claimCodeExpireHandler } from '../application/claim-codes.js';
import { readyUncollectedHandler } from './ready-uncollected.js';

export { readyUncollectedHandler, scheduleReadyUncollectedCheck } from './ready-uncollected.js';

/**
 * Worker handlers of tickets-custody (04 §4.2): `job.ready_uncollected_check` (TT-17 → `ready_not_collected`) and
 * `job.claim_code_expire` (PNT-047).
 */
export function ticketsCustodyJobs(): JobHandler[] {
  return [readyUncollectedHandler, claimCodeExpireHandler];
}
