import type { JobHandler } from '../../../core/outbox/dispatcher.js';

/**
 * Worker handlers of tickets-custody (04 §4.2: `job.ready_uncollected_check`, `job.claim_code_expire`). None in
 * S2: the claim code arrives with PNT-047 and the uncollected-ready alert with S4; `ready` schedules neither yet.
 */
export function ticketsCustodyJobs(): JobHandler[] {
  return [];
}
