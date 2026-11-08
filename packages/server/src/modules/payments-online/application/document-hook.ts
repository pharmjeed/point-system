import type { Tx } from '../../../core/db/tx.js';
import type { OnlinePaymentRow } from './payment-sync.js';

/** A refund that succeeded, as the documents hook receives it. */
export interface SucceededRefund {
  id: string;
  amount_halalas: number;
  reason: string;
  kind: 'manual' | 'system';
}

/**
 * The tax documents of POINT's online payments (V2-040, DEC-543): every payment whose money was taken gets a
 * simplified tax invoice, and every refund that succeeded a credit note. The invoicing module registers the hook at
 * load time (the VisitPaymentHook pattern): this module never writes an invoice itself. Both run in the transaction
 * of the payment's (or the refund's) own move, after its rows were written; issuing takes the invoice series row last.
 */
export interface PaymentDocumentsHook {
  /**
   * The payment reached paid / partially_refunded / refunded for the first time — generic on purpose: visit
   * payments now, subscription charges once V2-031 lands.
   */
  afterCaptured(tx: Tx, payment: OnlinePaymentRow): Promise<void>;
  /** A refund of the payment succeeded at the gateway. */
  afterRefund(tx: Tx, refund: SucceededRefund, payment: OnlinePaymentRow): Promise<void>;
}

let hook: PaymentDocumentsHook | null = null;

export function registerPaymentDocumentsHook(h: PaymentDocumentsHook | null): void {
  hook = h;
}

export function paymentDocumentsHook(): PaymentDocumentsHook | null {
  return hook;
}
