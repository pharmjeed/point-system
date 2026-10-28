import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { readyUncollectedHandler } from './ready-uncollected.js';

/**
 * Worker handlers of tickets-custody (04 §4.2: `job.ready_uncollected_check`, `job.claim_code_expire`). The
 * uncollected-ready timer raises `ready_not_collected` (PNT-075); the claim-code expiry arrives with PNT-047.
 */
export function ticketsCustodyJobs(): JobHandler[] {
  return [readyUncollectedHandler];
}
