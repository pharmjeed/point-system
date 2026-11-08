import type { Tx } from '../../../core/db/tx.js';
import type { CustomerRow, WaSenderIdentity } from '../infra/customers.js';
import { issueActionToken } from './action-tokens.js';
import { receiveLinkCode } from './link-service.js';
import { applyW01Outcome } from './ticket-link.js';

/**
 * Extension points of the WhatsApp adapter for the flows built on top of it (PNT-043 … PNT-047). Each
 * seam has a documented default so the adapter works end to end before the flow exists. Handlers run
 * INSIDE the transaction that processes the inbound message (or records the send), after the locks the
 * adapter took (advisory per sender; none of L1–L10), so they may lock in canon order from L1.
 */

/** The inbound message being processed (whatsapp_messages row, direction inbound). */
export interface InboundMessageRef {
  /** whatsapp_messages.id */
  id: string;
  /** provider id (wamid) */
  waMessageId: string;
  /** `context.id`: the message the customer replied to (W-01 for a button) */
  contextWamid: string | null;
  /** message time from the webhook (`timestamp`) */
  receivedAt: Date;
  /**
   * when the api stored the webhook delivery that carried it (`whatsapp_inbound_events.received_at`): the start
   * of «حفظ الطلب» (15 §10 `ingest_latency_ms`, 05 §12.2 `point_retrieval_request_ingest_seconds`)
   */
  webhookReceivedAt?: Date;
}

// ---------------------------------------------------------------------------------------------
// PNT-045 — «طلب السيارة» button press
// ---------------------------------------------------------------------------------------------

export interface ButtonPressContext {
  orgId: string;
  channelId: string;
  inbound: InboundMessageRef;
  sender: WaSenderIdentity;
  /** the sender, upserted by wa_id / BSUID (DEC-35), last_inbound_at already updated */
  customer: CustomerRow;
  /** sha256(button.payload) — the raw payload (the action token) is never stored or passed on */
  payloadHash: string;
  buttonText: string | null;
}

/** `wa.button_pressed` outcome (11 §8.10); the NotificationPlanner turns it into W-09 / W-10. */
export interface ButtonPressResult {
  outcome: 'request_created' | 'early_request' | 'status_reply' | 'rejected';
  reject_reason?: 'unknown_token' | 'sender_mismatch' | 'stale_link_version' | 'expired' | 'revoked';
  /** the token's ticket; null when nothing may be revealed (unknown token, other sender) */
  ticket_id: string | null;
  /** who gets the reply (normally the sender) */
  customer_id: string | null;
}

export type ButtonPressHandler = (tx: Tx, ctx: ButtonPressContext) => Promise<ButtonPressResult>;

/**
 * Without the retrieval flow (registered by the use-cases, PNT-045: the press goes through RequestRetrieval,
 * which composes dispatch — 04 §4.3 rule 3) every press is answered like an unknown token: W-10 guidance
 * without any ticket data (12 §6.5 rejection path).
 */
export const defaultButtonPressHandler: ButtonPressHandler = async (_tx, ctx) => ({
  outcome: 'rejected',
  reject_reason: 'unknown_token',
  ticket_id: null,
  customer_id: ctx.customer.id,
});

let buttonPress: ButtonPressHandler = defaultButtonPressHandler;

/** PNT-045: resolve the token (see action-tokens.ts), check sender / link_version / state, request the retrieval. */
export function registerButtonPressHandler(h: ButtonPressHandler): void {
  buttonPress = h;
}
export const buttonPressHandler = (): ButtonPressHandler => buttonPress;

// ---------------------------------------------------------------------------------------------
// PNT-044 — QR link code received in a text message
// ---------------------------------------------------------------------------------------------

export interface LinkCodeContext {
  orgId: string;
  channelId: string;
  /** the normalized 6-character code (`^[A-HJ-NP-Z2-9]{6}$`) */
  code: string;
  inbound: InboundMessageRef;
  sender: WaSenderIdentity;
  customer: CustomerRow;
}

/** W-11 variant (14 §4); `received` normally moves the link to pending_confirmation (12 §7.2). */
export interface LinkCodeResult {
  result: 'received' | 'invalid';
  ticket_id: string | null;
}

export type LinkCodeHandler = (tx: Tx, ctx: LinkCodeContext) => Promise<LinkCodeResult>;

/**
 * PNT-044 (12 §7.2 `handleLinkCode`): a live code moves to `pending_confirmation` and the ticket waits for
 * the driver's «هل هذا العميل أمامك؟»; anything else is W-11 «غير صالح». It touches only whatsapp and
 * tickets-custody rows, so the adapter's own implementation is the default.
 */
export const defaultLinkCodeHandler: LinkCodeHandler = receiveLinkCode;

let linkCode: LinkCodeHandler = defaultLinkCodeHandler;

export function registerLinkCodeHandler(h: LinkCodeHandler): void {
  linkCode = h;
}
export const linkCodeHandler = (): LinkCodeHandler => linkCode;

// ---------------------------------------------------------------------------------------------
// PNT-043 — W-01 action token and outcome
// ---------------------------------------------------------------------------------------------

export interface ActionTokenIssueContext {
  orgId: string;
  ticketId: string;
  customerId: string;
  /** tickets.link_version at send time (= the W-01 notification's link_version) */
  linkVersion: number;
  /** wa.action_token_ttl_h */
  ttlHours: number;
}

/** Returns the raw token for the quick-reply payload (kept in memory only) and its row id. */
export type ActionTokenIssuer = (
  tx: Tx,
  ctx: ActionTokenIssueContext,
) => Promise<{ id: string; token: string }>;

/**
 * Default: a fresh 128-bit token per W-01 send attempt, issued in the sender's reservation transaction;
 * only sha256(token) is stored (12 §5.11 «the raw value lives in the sender's memory at build time»).
 */
export const defaultActionTokenIssuer: ActionTokenIssuer = (tx, ctx) => issueActionToken(tx, ctx);

let tokenIssuer: ActionTokenIssuer = defaultActionTokenIssuer;

export function registerActionTokenIssuer(i: ActionTokenIssuer): void {
  tokenIssuer = i;
}
export const actionTokenIssuer = (): ActionTokenIssuer => tokenIssuer;

export interface W01OutcomeContext {
  ticketId: string;
  notificationId: string;
  /** the W-01's link_version; an outcome of an older W-01 changes nothing */
  linkVersion: number | null;
  outcome: 'accepted' | 'failed';
  /** provider/internal error code for `failed` */
  errorCode: string | null;
  action: 'job.wa_send' | 'job.wa_process_inbound';
}

export type W01OutcomeHandler = (tx: Tx, ctx: W01OutcomeContext) => Promise<void>;

/** Default (11 §6.2): pending_send → linked on acceptance; pending_send/linked → failed on a permanent error. */
export const defaultW01OutcomeHandler: W01OutcomeHandler = applyW01Outcome;

let w01Outcome: W01OutcomeHandler = defaultW01OutcomeHandler;

export function registerW01OutcomeHandler(h: W01OutcomeHandler): void {
  w01Outcome = h;
}
export const w01OutcomeHandler = (): W01OutcomeHandler => w01Outcome;

/** Restores every default (tests). */
export function resetWhatsappSeams(): void {
  buttonPress = defaultButtonPressHandler;
  linkCode = defaultLinkCodeHandler;
  tokenIssuer = defaultActionTokenIssuer;
  w01Outcome = defaultW01OutcomeHandler;
}
