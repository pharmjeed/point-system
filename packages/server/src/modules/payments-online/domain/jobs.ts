/** The worker jobs of the online payments (canon §7.2 V2 row; V2-021, DEC-512 … DEC-514). */
export const PAYMENT_WEBHOOK_PROCESS_JOB = 'job.payment_webhook_process';
export const PAYMENT_REFUND_SEND_JOB = 'job.payment_refund_send';
export const PAYMENTS_RECONCILE_JOB = 'job.payments_reconcile';
/** V2-023 (DEC-524): a removed saved card's token deleted at the gateway after COMMIT. */
export const PAYMENT_METHOD_TOKEN_DELETE_JOB = 'job.payment_method_token_delete';
