import type { EventStatus } from '@point/shared';
import { AppError } from '../../../core/errors/app-error.js';
import { invalidTransition } from './errors.js';

/**
 * `events.status` (11 §6.4): draft → open → closing → closed; closing → open (reopen, canon §5 note);
 * draft/open → canceled. `closed` and `canceled` are final: any command on them is EVENT_ALREADY_CLOSED.
 * start-closing / close belong to S6/S7 and are not implemented here.
 */
export const FINAL_EVENT_STATUSES: readonly EventStatus[] = ['closed', 'canceled'];

export interface EventStateRow {
  id: string;
  status: EventStatus;
  version: number;
}

function assertNotFinal(ev: EventStateRow): void {
  if (FINAL_EVENT_STATUSES.includes(ev.status)) {
    throw new AppError('EVENT_ALREADY_CLOSED', { event_id: ev.id, current_status: ev.status });
  }
}

/** PATCH /v1/events/{eventId}: editable while draft or open (13 §3); closing → INVALID_STATE_TRANSITION. */
export function assertEventEditable(ev: EventStateRow, command: string): void {
  assertNotFinal(ev);
  if (ev.status !== 'draft' && ev.status !== 'open') {
    throw invalidTransition({
      entityType: 'event',
      entityId: ev.id,
      currentStatus: ev.status,
      currentVersion: ev.version,
      command,
      allowedFrom: ['draft', 'open'],
    });
  }
}

/** POST /v1/events/{eventId}/open: draft → open, or closing → open (`reopened`). */
export function openTransition(ev: EventStateRow, command: string): { reopened: boolean } {
  assertNotFinal(ev);
  if (ev.status === 'draft') return { reopened: false };
  if (ev.status === 'closing') return { reopened: true };
  throw invalidTransition({
    entityType: 'event',
    entityId: ev.id,
    currentStatus: ev.status,
    currentVersion: ev.version,
    command,
    allowedFrom: ['draft', 'closing'],
  });
}

/** POST /v1/events/{eventId}/cancel: from draft or open only (11 §6.4). */
export function assertCancelable(ev: EventStateRow, command: string): void {
  assertNotFinal(ev);
  if (ev.status !== 'draft' && ev.status !== 'open') {
    throw invalidTransition({
      entityType: 'event',
      entityId: ev.id,
      currentStatus: ev.status,
      currentVersion: ev.version,
      command,
      allowedFrom: ['draft', 'open'],
    });
  }
}

/** The dispatch pool of an event is fixed once it opened (06 ERD `events.dispatch_pool_id` «ثابت بعد الفتح»). */
export function assertPoolChangeAllowed(ev: EventStateRow, command: string): void {
  if (ev.status !== 'draft') {
    throw invalidTransition({
      entityType: 'event',
      entityId: ev.id,
      currentStatus: ev.status,
      currentVersion: ev.version,
      command,
      allowedFrom: ['draft'],
      reason: 'dispatch_pool_fixed_after_open',
    });
  }
}

/** Minimum reason length for REASON_REQUIRED (08 §4.3). */
export const MIN_REASON_LENGTH = 3;

/** The cancel reason is checked with the input shape, before the event is loaded (08 §2 step 6). */
export function requireReason(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  if (r.length < MIN_REASON_LENGTH) {
    throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: MIN_REASON_LENGTH });
  }
  return r;
}
