// Public surface of the subscriptions module (V2-030 … V2-035; docs/v2/04 §1–§2; DEC-531 … DEC-539): plans (P-05),
// the subscription machine and its timers, the customer's checkout and commands (C-09/C-10/C-14), the entitlement at
// intake, the freeze with the operator and the venue, and the platform's P-07.
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { defaultPaymentsRuntime, PaymentsRuntime } from '../payments-online/index.js';
import { subscriptionJobs } from './application/jobs.js';
// the payment hook and the lifecycle hook register themselves when the module loads (api and worker)
import './application/payment-hook.js';
import './application/lifecycle.js';

export { SubscriptionsHttpModule } from './subscriptions.module.js';
export {
  PENDING_PAYMENT_EXPIRE_JOB,
  SUBSCRIPTION_GRACE_EXPIRE_JOB,
  SUBSCRIPTION_RENEW_JOB,
  SUBSCRIPTION_RENEWAL_NOTICE_JOB,
  renewalGivenId,
  checkoutGivenId,
} from './domain/jobs.js';
export {
  applySubscriptionEntitlement,
  subscriptionCoverage,
  type CoverageResult,
  type EntitlementTicket,
  type SubscriptionCoverage,
} from './application/entitlement.js';
export { subscriptionLifecycleEffects } from './application/lifecycle.js';
export { subscriptionPaymentEffects } from './application/payment-hook.js';
export { SubscriptionCheckout, type CheckoutPlan } from './application/checkout.js';
export { SubscriptionCommands } from './application/commands.js';
export { PlatformPlansService } from './application/plans.js';
export { PlatformSubscriptionsService } from './application/reports.js';
export { customerSubscriptions } from './application/views.js';
export { subscriptionById, type SubscriptionRow } from './application/rows.js';

type RuntimeOption = PaymentsRuntime | (() => PaymentsRuntime);

/** worker process: the four subscription timers (canon §7.2 V2 rows). */
export function subscriptionsJobs(opts: { runtime?: RuntimeOption } = {}): JobHandler[] {
  const given = opts.runtime;
  const runtime =
    given instanceof PaymentsRuntime ? () => given : typeof given === 'function' ? given : defaultPaymentsRuntime;
  return subscriptionJobs(runtime);
}
