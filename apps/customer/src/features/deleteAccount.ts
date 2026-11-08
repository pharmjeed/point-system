/**
 * C-20 حذف الحساب (V2-017, an App Store and Google Play requirement; DEC-507, DEC-508). Three steps:
 *
 * 1. `confirm` — what deleting means (subscriptions end, invoices are kept as the law requires, vehicles and
 *    sign-in go, the operators keep their own visit records), and «أرسل رمز التأكيد على واتساب»;
 * 2. `code` — the fresh WhatsApp code for the account's own number (`POST /v1/customer/auth/otp`, then
 *    `POST /v1/customer/auth/reauth/verify`): the C-03 rules (attempts, lock, resend wait) through ./otp.ts;
 * 3. `deleting` — `DELETE /v1/customer/me` with the proof; then the app returns to C-01.
 *
 * A visit in progress refuses the deletion (`CUSTOMER_ACCOUNT_VISIT_ACTIVE`): the customer collects the car first.
 * An expired or replaced proof (`CUSTOMER_REAUTH_REQUIRED`) sends the customer back to step 1 for a new code. Pure.
 */
import { ApiError } from '../api/errors';

export type DeleteStep = 'confirm' | 'code' | 'deleting';

export type DeleteIssue = 'visit_active' | 'reauth' | null;

/** The deletion's own refusals; anything else is handled like any other error (errorText). */
export function deleteIssueFromError(e: unknown): DeleteIssue {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'CUSTOMER_ACCOUNT_VISIT_ACTIVE') return 'visit_active';
  if (e.code === 'CUSTOMER_REAUTH_REQUIRED') return 'reauth';
  return null;
}

/** The step after a refused deletion: back to the start for a new code, or stay to show the reason. */
export function stepAfterDeleteError(issue: DeleteIssue): DeleteStep {
  return issue === 'reauth' || issue === 'visit_active' ? 'confirm' : 'code';
}

/** Where the app goes once the account is gone: C-01 (journey R1 starts over). */
export const AFTER_DELETE_ROUTE = '/welcome' as const;
