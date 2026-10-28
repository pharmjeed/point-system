import type { EventProjector, JobHandler } from '@point/server';

/** Every job.* handler of the worker (registered sprint by sprint, 04 §6.6). */
export function allHandlers(): JobHandler[] {
  return [];
}

/** Consumers of domain events (AnalyticsProjector, AlertAutoResolver…). */
export function allProjectors(): EventProjector[] {
  return [];
}
