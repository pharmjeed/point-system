import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { claimCodeExpireHandler } from '../application/claim-codes.js';

/**
 * Worker handlers of tickets-custody (04 §4.2): `job.claim_code_expire` (PNT-047). `job.ready_uncollected_check`
 * arrives with S4 (PNT-058); `ready` does not schedule it yet.
 */
export function ticketsCustodyJobs(): JobHandler[] {
  return [claimCodeExpireHandler];
}
