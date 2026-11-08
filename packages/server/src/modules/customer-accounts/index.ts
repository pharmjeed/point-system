// Public surface of the customer-accounts module (V2-010): the customer API `/v1/customer/*` and its worker job.
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { defaultWhatsappRuntime, WhatsappRuntime } from '../whatsapp/index.js';
import { customerOtpSendHandler } from './application/otp-sender.js';
import {
  customerPushReceiptsHandler,
  customerPushSendHandler,
  startCustomerPushPlanner,
} from './application/customer-push.js';
import { startCustomerRealtime } from './application/customer-realtime.js';
import { CustomerPushRuntime, defaultCustomerPushRuntime } from './infra/customer-push.js';

export { CustomerAccountsHttpModule } from './customer-accounts.module.js';
export { CUSTOMER_OTP_SEND_JOB, CustomerOtpService, otpCodeHash } from './application/otp-service.js';
export { customerOtpSendHandler } from './application/otp-sender.js';
export { pointChannel, type PointChannel } from './application/point-channel.js';
export { buildCustomerMe, consentTexts, type ConsentTexts } from './application/account-views.js';
export { distanceMetres } from './application/locations.js';
export { lockCustomerAccount } from './application/account-service.js';
export { deletedPhoneHash, hasVisitInProgress } from './application/account-deletion.js';
// V2-013 / V2-014 (DEC-500, DEC-504): the entry pass verified at intake, and the account's visits across operators
export {
  getCustomerPass,
  markPassUsed,
  passSecrets,
  PASS_PREVIOUS_GRACE_DAYS,
  PASS_ROTATE_AFTER_DAYS,
  verifyIntakePass,
  type PassKeys,
  type VerifiedPass,
} from './application/pass.js';
export {
  customerVisitDetail,
  findAccountVisit,
  listAccountVisits,
  listCustomerVisits,
  visitNotFound,
  visitSummary,
  type AccountVisit,
  type AccountVisitsOptions,
  type VisitDetailDeps,
} from './application/visits.js';
// V2-015 / V2-016 (DEC-516 … DEC-520): C-13, push registration and sending, the customer socket
export { rateCustomerVisit } from './application/ratings.js';
export { registerCustomerDevice } from './application/devices.js';
export {
  CUSTOMER_PUSH_RECEIPTS_JOB,
  CUSTOMER_PUSH_SEND_JOB,
  customerPushIntents,
  customerPushPlanner,
  customerPushReceiptsHandler,
  customerPushSendHandler,
  planCustomerPush,
  pruneCustomerPushToken,
  startCustomerPushPlanner,
  stopCustomerPushPlanner,
  type CustomerPushIntent,
  type CustomerPushPlan,
} from './application/customer-push.js';
export {
  CUSTOMER_VISIT_PUSH_KINDS,
  customerPushContent,
  customerSubscriptionPushContent,
  type CustomerPushContent,
  type CustomerPushMessage,
} from './application/push-messages.js';
export {
  publishVisitUpdated,
  startCustomerRealtime,
  stopCustomerRealtime,
} from './application/customer-realtime.js';
export {
  CustomerPushRuntime,
  CustomerPushSimulator,
  CustomerPushTransportError,
  defaultCustomerPushRuntime,
  defaultCustomerPushSimulator,
  DEVICE_NOT_REGISTERED,
  ExpoPushSender,
  type CustomerPushDeps,
  type CustomerPushSender,
  type PushReceipt,
  type PushTicket,
  type SimulatedPush,
} from './infra/customer-push.js';

/** The customer app's planners (idempotent; the api and the worker both plan in their transactions). */
export function registerCustomerPlanners(): void {
  startCustomerPushPlanner();
  startCustomerRealtime();
}

/**
 * worker process: `job.customer_otp_send` (DEC-496), `job.customer_push_send` and `job.customer_push_receipts`
 * (DEC-519), and the customer planners for the worker's transactions. The WhatsApp runtime is built lazily from the validated process
 * environment unless one is given (tests).
 */
export function customerAccountsJobs(
  opts: {
    runtime?: WhatsappRuntime | (() => WhatsappRuntime);
    push?: CustomerPushRuntime | (() => CustomerPushRuntime);
  } = {},
): JobHandler[] {
  startCustomerPushPlanner();
  startCustomerRealtime();
  const givenPush = opts.push;
  const push =
    givenPush instanceof CustomerPushRuntime
      ? () => givenPush
      : typeof givenPush === 'function'
        ? givenPush
        : defaultCustomerPushRuntime;
  const given = opts.runtime;
  const runtime =
    given instanceof WhatsappRuntime
      ? () => given
      : typeof given === 'function'
        ? given
        : defaultWhatsappRuntime;
  return [customerOtpSendHandler(runtime), customerPushSendHandler(push), customerPushReceiptsHandler(push)];
}
