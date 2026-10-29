import type { Tx } from '../../../core/db/tx.js';

/**
 * A `ticket.updated` (07 §4.3) asked by tickets-custody where no domain event of the canon carries the change — a
 * handover code that expires (`job.claim_code_expire`, 14 §3.7: «انتهى الرمز — أعد الإرسال» for the assignee and
 * S-03's ClaimCodeState for the supervisors). The publisher is the notifications coalescer, wired by the use-cases
 * layer (04 §4.3: tickets-custody does not import notifications); unwired, nothing is published.
 */
export type CustodyTicketUpdatePublisher = (tx: Tx, ticketId: string, cause: string) => Promise<void>;

let publisher: CustodyTicketUpdatePublisher | null = null;

export function registerCustodyTicketUpdatePublisher(p: CustodyTicketUpdatePublisher | null): void {
  publisher = p;
}

export async function requestCustodyTicketUpdate(tx: Tx, ticketId: string, cause: string): Promise<void> {
  await publisher?.(tx, ticketId, cause);
}
