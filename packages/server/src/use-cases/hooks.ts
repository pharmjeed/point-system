import type { ActorContext } from '../core/actor-context/actor-context.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import { openIncident } from '../modules/incidents/index.js';
import type { CycleRow, TicketRow } from '../modules/tickets-custody/index.js';

/**
 * Extension points of the S2 vertical slice, named after the tickets that fill them. Each has a safe S2
 * default; the owning module registers its implementation at import time (same pattern as DriverReleaseHook).
 */

/**
 * PNT-043 (W-01): starts the customer's WhatsApp linking when the draft is submitted with the direct method
 * (11 TT-03: `wa_link_status = pending_send`; WA_TEMPLATE_NOT_APPROVED checks of the whatsapp module). It runs in
 * the SubmitIntake transaction after the ticket moved to `parking` and before `ticket.intake_submitted` is
 * emitted, and returns the ticket row after its change, so the event carries the resulting `wa_link_status`
 * (the NotificationPlanner plans W-01 from it; the whatsapp sender issues the action token, 12 §5.11).
 * S2 default: nothing (`null`, the ticket stays `none`).
 */
export interface CustomerLinkingHook {
  onIntakeSubmitted(
    tx: Tx,
    ctx: { ticket: TicketRow; actor: ActorContext; requestId: string },
  ): Promise<TicketRow | null>;
}

/**
 * PNT-047: handover code issued at `ready` (claim_codes, W-05, job.claim_code_expire) and verified at
 * `handover` with `method = code`. S2 default: no code is issued, so `method = code` is not applicable.
 */
export interface ClaimCodeHook {
  issueAtReady(
    tx: Tx,
    ctx: { ticket: TicketRow; cycle: CycleRow; actor: ActorContext },
  ): Promise<{ claim_code_id: string; expires_at: string } | null>;
  verifyAtHandover(
    tx: Tx,
    ctx: { ticket: TicketRow; cycle: CycleRow; code: string; actor: ActorContext },
  ): Promise<{ claim_code_id: string }>;
}

/**
 * PNT-080: payment collected inside the handover (TT-18). S2 default: a due ticket cannot be delivered
 * (PAYMENT_PENDING) even when the body carries a payment.
 */
export interface InlinePaymentHook {
  /**
   * 13 §5.3 step 5 (PNT-080): the money checks of the handover — after the custody checks, before the code or
   * stub is verified, without any effect — so a wrong amount or method never consumes an attempt. Without it the
   * handover keeps the S2 gate.
   */
  check?(
    tx: Tx,
    ctx: {
      ticket: TicketRow;
      payment: { method: 'cash' | 'pos'; amount_halalas: number; pos_reference?: string | null } | null;
      actor: ActorContext;
    },
  ): Promise<void>;
  collect(
    tx: Tx,
    ctx: {
      ticket: TicketRow;
      cycle: CycleRow;
      payment: { method: 'cash' | 'pos'; amount_halalas: number; pos_reference?: string | null };
      actor: ActorContext;
      requestId?: string;
      /**
       * 13 §8.4: in the supervisor's exceptional handover the money was taken by `collectedBy` (the assignee by
       * default, or the supervisor himself) and the payment is recorded with `source = exception`; the plain
       * handover is collected by its actor, the assignee (`source = handover`).
       */
      collectedBy?: string;
      source?: 'handover' | 'exception';
      operation?: string;
    },
  ): Promise<Record<string, unknown>>;
}

const noLinking: CustomerLinkingHook = {
  async onIntakeSubmitted() {
    return null; // PNT-043 registers the W-01 flow here
  },
};

const noClaimCode: ClaimCodeHook = {
  async issueAtReady() {
    return null;
  },
  async verifyAtHandover() {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ field: 'verification.method', issue: 'not_applicable' }],
    });
  },
};

let linking: CustomerLinkingHook = noLinking;
let claimCodes: ClaimCodeHook = noClaimCode;
let inlinePayment: InlinePaymentHook | null = null;

export function registerCustomerLinkingHook(h: CustomerLinkingHook | null): void {
  linking = h ?? noLinking;
}
export function registerClaimCodeHook(h: ClaimCodeHook | null): void {
  claimCodes = h ?? noClaimCode;
}
export function registerInlinePaymentHook(h: InlinePaymentHook | null): void {
  inlinePayment = h;
}

export const customerLinking = () => linking;
export const claimCodeHook = () => claimCodes;
export const inlinePaymentHook = () => inlinePayment;

/**
 * S4 (PNT-061): TT-20 leaves a documented `customer_absent` incident (11 §2.3). The default recorder is the
 * incidents module's writer (`openIncident`): the row already `resolved` (the repark is the resolution), severity
 * `low`, owned by the supervisor, with `incident.opened` + `incident.resolved` (11 §8.8) in the command's
 * transaction — both payloads report the stored `resolved` status and `auto_created: true` (S4 DEC-PROPOSED-10).
 * A test may register another recorder.
 */
export interface IncidentRecorder {
  recordDocumented(
    tx: Tx,
    i: {
      orgId: string;
      venueId: string;
      eventId: string | null;
      ticketId: string | null;
      type: 'customer_absent';
      description: string;
      resolution: string;
      actorId: string;
    },
  ): Promise<{ incident_id: string }>;
}

const directIncidents: IncidentRecorder = {
  async recordDocumented(tx, i) {
    const r = await openIncident(tx, {
      orgId: i.orgId,
      venueId: i.venueId,
      eventId: i.eventId,
      ticketId: i.ticketId,
      type: i.type,
      severity: 'low',
      description: i.description,
      openedBy: i.actorId,
      ownerId: i.actorId,
      actor: { type: 'user', id: i.actorId },
      resolution: i.resolution,
      autoCreated: true,
      openedStatus: 'stored',
    });
    return { incident_id: r.id };
  },
};

let incidents: IncidentRecorder = directIncidents;

export function registerIncidentRecorder(h: IncidentRecorder | null): void {
  incidents = h ?? directIncidents;
}

export const incidentRecorder = () => incidents;
