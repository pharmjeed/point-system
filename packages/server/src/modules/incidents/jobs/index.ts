import type { EventProjector, JobHandler } from '../../../core/outbox/dispatcher.js';
import { createAlertAutoResolver } from '../application/alert-auto-resolver.js';

/** Worker handlers of the incidents module: none (alerts are raised by their producers' jobs, 14 §8). */
export function incidentsJobs(): JobHandler[] {
  return [];
}

/** Domain-event consumers of the incidents module: the AlertAutoResolver (11 §6.10). */
export function incidentsProjectors(): EventProjector[] {
  return [createAlertAutoResolver()];
}
