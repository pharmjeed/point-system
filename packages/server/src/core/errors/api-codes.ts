import { ERROR_CATALOG, isErrorCode, type ErrorCode, type ErrorDef } from '@point/shared';
import { CUSTOMER_ERROR_CATALOG, CUSTOMER_ERROR_CODES, type CustomerErrorCode } from '@point/shared/customer';

/**
 * Every code the server answers with: canon §8 (`ERROR_CATALOG`, 08 §4) and the V2 customer API codes
 * (`CUSTOMER_ERROR_CATALOG`, docs/v2/05 §5, DEC-482). The two catalogs never share a code (packages/shared test),
 * so a code has exactly one definition; a customer code is only thrown on `/v1/customer/*` (V2-010).
 */
export type ApiErrorCode = ErrorCode | CustomerErrorCode;

export function isCustomerErrorCode(value: unknown): value is CustomerErrorCode {
  return typeof value === 'string' && (CUSTOMER_ERROR_CODES as readonly string[]).includes(value);
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return isErrorCode(value) || isCustomerErrorCode(value);
}

/** HTTP status, texts, `retryable` and log level of a code. */
export function apiErrorDef(code: ApiErrorCode): Omit<ErrorDef, 'alert'> & { alert?: ErrorDef['alert'] } {
  return isCustomerErrorCode(code) ? CUSTOMER_ERROR_CATALOG[code] : ERROR_CATALOG[code];
}
