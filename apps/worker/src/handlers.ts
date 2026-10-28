import type { EventProjector, JobHandler } from '@point/server';

// Every job.* handler (04 §6.6) and domain-event projector, one block per module (blank lines between them).

const handlers: JobHandler[] = [];
const projectors: EventProjector[] = [];

// import { identityAccessJobs } from '@point/server';
// handlers.push(...identityAccessJobs());

// import { venuesEventsJobs } from '@point/server';
// handlers.push(...venuesEventsJobs());

// import { ticketsCustodyJobs } from '@point/server';
// handlers.push(...ticketsCustodyJobs());

// import { dispatchJobs } from '@point/server';
// handlers.push(...dispatchJobs());

import { whatsappJobs } from '@point/server';
handlers.push(...whatsappJobs());

import { notificationsJobs } from '@point/server';
handlers.push(...notificationsJobs());

// import { incidentsJobs, incidentsProjectors } from '@point/server';
// handlers.push(...incidentsJobs());
// projectors.push(...incidentsProjectors());

// import { paymentsReportsJobs } from '@point/server';
// handlers.push(...paymentsReportsJobs());

// import { auditMonitoringJobs, auditMonitoringProjectors } from '@point/server';
// handlers.push(...auditMonitoringJobs());
// projectors.push(...auditMonitoringProjectors());

// import { mediaJobs } from '@point/server';
// handlers.push(...mediaJobs());

export function allHandlers(): JobHandler[] {
  return handlers;
}

export function allProjectors(): EventProjector[] {
  return projectors;
}
