// Public surface of the customer-accounts module (V2-010): the customer API `/v1/customer/*` and its worker job.
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { defaultWhatsappRuntime, WhatsappRuntime } from '../whatsapp/index.js';
import { customerOtpSendHandler } from './application/otp-sender.js';

export { CustomerAccountsHttpModule } from './customer-accounts.module.js';
export { CUSTOMER_OTP_SEND_JOB, CustomerOtpService, otpCodeHash } from './application/otp-service.js';
export { customerOtpSendHandler } from './application/otp-sender.js';
export { pointChannel, type PointChannel } from './application/point-channel.js';
export { buildCustomerMe, consentTexts, type ConsentTexts } from './application/account-views.js';
export { distanceMetres } from './application/locations.js';
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
export { listAccountVisits, type AccountVisit, type AccountVisitsOptions } from './application/visits.js';

/**
 * worker process: `job.customer_otp_send` (DEC-496). The WhatsApp runtime is built lazily from the validated process
 * environment unless one is given (tests).
 */
export function customerAccountsJobs(
  opts: { runtime?: WhatsappRuntime | (() => WhatsappRuntime) } = {},
): JobHandler[] {
  const given = opts.runtime;
  const runtime =
    given instanceof WhatsappRuntime
      ? () => given
      : typeof given === 'function'
        ? given
        : defaultWhatsappRuntime;
  return [customerOtpSendHandler(runtime)];
}
