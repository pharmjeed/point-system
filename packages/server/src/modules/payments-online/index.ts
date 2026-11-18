// Public surface of the payments-online module (V2-020 / V2-021, DEC-510 … DEC-514): the PaymentGateway, its
// Moyasar adapter, the online payments, their webhook, refunds and the daily reconciliation.
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { ensureReconcileScheduled, paymentsReconcileJob } from './application/reconciliation.js';
import { paymentRefundJob } from './application/refunds.js';
import { paymentMethodTokenDeleteJob } from './application/card-tokens.js';
import { paymentWebhookJob } from './application/webhooks.js';
import { defaultPaymentsRuntime, PaymentsRuntime } from './runtime.js';

export { PaymentsOnlineHttpModule } from './payments-online.module.js';
export { PaymentsRuntime, defaultPaymentsRuntime, type PaymentsDeps } from './runtime.js';
export {
  MoyasarGateway,
  keyAllowed,
  normalizePayment,
  type MoyasarKeyPolicy,
  type MoyasarOptions,
} from './infra/moyasar.js';
export type * from './domain/gateway.js';
export { retryableFailure } from './domain/gateway.js';
export { decideSync, localStatusOf, type SyncDecision } from './domain/status.js';
export { sanitizePayment, sanitizeWebhookBody, PAN_LIKE } from './domain/sanitize.js';
export {
  OnlinePayments,
  type StartPaymentInput,
  type StartedPayment,
} from './application/online-payments.js';
export {
  applyGatewayPayment,
  paymentById,
  paymentOfGateway,
  type OnlinePaymentRow,
  type SyncCause,
} from './application/payment-sync.js';
export { PaymentWebhookIntake, paymentWebhookJob } from './application/webhooks.js';
export { RefundsService, paymentRefundJob, refundView } from './application/refunds.js';
export { PlatformPaymentsConsole } from './application/platform-console.js';
export {
  PaymentsReconciler,
  ensureReconcileScheduled,
  paymentsReconcileJob,
  riyadhDate,
  riyadhDayWindow,
  scheduleReconcile,
  type ReconciliationMismatch,
  type ReconciliationResult,
} from './application/reconciliation.js';
export { platformOrgId } from './application/platform-org.js';
// V2-022 / V2-023 (DEC-521 … DEC-525): the visit hook, saved cards' tokens, system refunds
export {
  registerVisitPaymentHook,
  visitPaymentHook,
  type VisitPaymentHook,
} from './application/visit-hook.js';
// V2-031 (DEC-532): what a subscription payment's moves do to its subscription
export {
  registerSubscriptionPaymentHook,
  subscriptionPaymentHook,
  type SubscriptionPaymentHook,
} from './application/subscription-hook.js';
export {
  confirmPendingCard,
  dropPendingCard,
  paymentMethodTokenDeleteJob,
  queueTokenDeletion,
} from './application/card-tokens.js';
export { issueSystemRefund, paymentSummary } from './application/refunds.js';
export { normalizeToken } from './infra/moyasar.js';
// V2-040 (DEC-543): the tax documents of every captured payment and succeeded refund (registered by invoicing)
export {
  paymentDocumentsHook,
  registerPaymentDocumentsHook,
  type PaymentDocumentsHook,
  type SucceededRefund,
} from './application/document-hook.js';
export { ONLINE_PAYMENT_COLUMNS } from './application/payment-sync.js';
export {
  PAYMENT_WEBHOOK_PROCESS_JOB,
  PAYMENT_REFUND_SEND_JOB,
  PAYMENTS_RECONCILE_JOB,
  PAYMENT_METHOD_TOKEN_DELETE_JOB,
} from './domain/jobs.js';

type RuntimeOption = PaymentsRuntime | (() => PaymentsRuntime);
const asFactory = (given?: RuntimeOption): (() => PaymentsRuntime) =>
  given instanceof PaymentsRuntime
    ? () => given
    : typeof given === 'function'
      ? given
      : defaultPaymentsRuntime;

/** worker process: the webhook processing, the refund sender and the daily reconciliation (canon §7.2 V2 row). */
export function paymentsOnlineJobs(
  opts: { runtime?: RuntimeOption; reconcileCron?: string } = {},
): JobHandler[] {
  const runtime = asFactory(opts.runtime);
  return [
    paymentWebhookJob(runtime),
    paymentRefundJob(runtime),
    paymentsReconcileJob(runtime, opts.reconcileCron ? { cron: opts.reconcileCron } : {}),
    paymentMethodTokenDeleteJob(runtime),
  ];
}

/**
 * worker background service: keeps one `job.payments_reconcile` scheduled (on start, then hourly — a dead run or a
 * first deployment would otherwise leave no daily run).
 */
export function paymentsOnlineWorkerService(deps: { env: Env; db: Database; clock: Clock; logger: Logger }) {
  let timer: NodeJS.Timeout | null = null;
  const ensure = () =>
    deps.db
      .transaction((tx) => ensureReconcileScheduled(tx, deps.env.PAYMENTS_RECONCILE_CRON_UTC))
      .catch((err: unknown) =>
        deps.logger.warn({ err: (err as Error).message }, 'payments reconciliation not scheduled'),
      );
  return {
    start() {
      void ensure();
      timer = setInterval(() => void ensure(), 3_600_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
