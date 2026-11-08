import type { Tx } from '../../../core/db/tx.js';
import type { OnlinePaymentRow } from './payment-sync.js';

/**
 * What a visit payment's moves mean for its ticket (V2-022, DEC-522, DEC-523). The ticket is the operator's
 * (tickets-custody), the payment POINT's: this module never touches a ticket itself; the use-case layer registers the
 * hook at load time (the InlinePaymentHook pattern), and `applyGatewayPayment` calls it in the transaction of the
 * payment's own move, holding the payment row's lock (the hook then takes the retrieval task L4 and the ticket L5).
 */
export interface VisitPaymentHook {
  /**
   * The gateway says the payment is paid and it does not count yet. `apply`: the payment may move (it collected the
   * ticket, or it is given back as a double payment — DEC-523); `hold`: another online payment already counts for
   * the ticket (`uq_online_payments_ticket_paid`), so the move is not applied and the money goes back.
   */
  beforePaid(tx: Tx, payment: OnlinePaymentRow): Promise<'apply' | 'hold'>;
  /** After the payment moved to `paid` / `partially_refunded` (the first time it counts). */
  afterPaid(tx: Tx, payment: OnlinePaymentRow): Promise<void>;
  /** After a counting payment was refunded in full. */
  afterRefunded(tx: Tx, payment: OnlinePaymentRow): Promise<void>;
}

let hook: VisitPaymentHook | null = null;

export function registerVisitPaymentHook(h: VisitPaymentHook): void {
  hook = h;
}

export function visitPaymentHook(): VisitPaymentHook | null {
  return hook;
}
