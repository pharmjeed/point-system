import type { Clock, Database, Env, EventProjector, JobHandler, Logger } from '@point/server';

// Every job.* handler (04 §6.6), domain-event projector and background service, one block per module (blank
// lines between them).

const handlers: JobHandler[] = [];
const projectors: EventProjector[] = [];

/** The worker's singletons, given to the background services. */
export interface WorkerDeps {
  env: Env;
  db: Database;
  clock: Clock;
  logger: Logger;
}

/** Something that lives as long as the process outside the outbox (a loop that watches it, a client). */
export interface WorkerService {
  start?(): void;
  stop(): Promise<void>;
}

const services: ((deps: WorkerDeps) => WorkerService | null)[] = [];

// import { identityAccessJobs } from '@point/server';
// handlers.push(...identityAccessJobs());

// import { venuesEventsJobs } from '@point/server';
// handlers.push(...venuesEventsJobs());

import { ticketsCustodyJobs } from '@point/server';
handlers.push(...ticketsCustodyJobs());

import { dispatchJobs } from '@point/server';
handlers.push(...dispatchJobs());

import { whatsappJobs } from '@point/server';
handlers.push(...whatsappJobs());

import { notificationsJobs } from '@point/server';
handlers.push(...notificationsJobs());

// import { incidentsJobs, incidentsProjectors } from '@point/server';
// handlers.push(...incidentsJobs());
// projectors.push(...incidentsProjectors());

// import { paymentsReportsJobs } from '@point/server';
// handlers.push(...paymentsReportsJobs());

import { auditMonitoringJobs, auditMonitoringMonitor, auditMonitoringProjectors } from '@point/server';
handlers.push(...auditMonitoringJobs());
projectors.push(...auditMonitoringProjectors());
services.push((deps) => auditMonitoringMonitor(deps));

// import { mediaJobs } from '@point/server';
// handlers.push(...mediaJobs());
import { createObjectStorage, deleterForStore, registerMediaObjectDeleter } from '@point/server';
services.push((deps) => {
  // job.retention_purge deletes photo objects through the media module's storage (core seam, 04 §4.3)
  const storage = createObjectStorage(deps.env, deps.clock, deps.logger);
  registerMediaObjectDeleter(deleterForStore(storage), 'media');
  return {
    async stop() {
      registerMediaObjectDeleter(null, 'media');
      await storage.close?.();
    },
  };
});

export function allHandlers(): JobHandler[] {
  return handlers;
}

export function allProjectors(): EventProjector[] {
  return projectors;
}

export function allServices(): ((deps: WorkerDeps) => WorkerService | null)[] {
  return services;
}
