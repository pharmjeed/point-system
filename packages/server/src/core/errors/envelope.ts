import { ERROR_CATALOG, type ErrorCode } from '@point/shared';

export interface ErrorEnvelopeBody {
  error: {
    code: ErrorCode;
    message: string;
    message_ar: string;
    request_id: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

/** Canon §8 envelope. HTTP status always equals the catalog status of the code (08 §1.3). */
export function errorEnvelope(
  code: ErrorCode,
  details: Record<string, unknown>,
  requestId: string,
): ErrorEnvelopeBody {
  const def = ERROR_CATALOG[code];
  return {
    error: {
      code,
      message: def.message,
      message_ar: def.message_ar,
      request_id: requestId,
      retryable: def.retryable,
      details,
    },
  };
}

export function successEnvelope<T>(
  data: T,
  requestId: string,
  serverTime: Date,
  extra: Record<string, unknown> = {},
) {
  return { data, meta: { request_id: requestId, server_time: serverTime.toISOString(), ...extra } };
}
