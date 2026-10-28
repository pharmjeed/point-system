import { randomBytes } from 'node:crypto';

/**
 * Classes follow docs/12 §5.9: temporary → retry with backoff · permanent → `failed` ·
 * template → `failed` + template status · channel → channel `down`/`degraded`.
 */
export type GraphErrorClass = 'temporary' | 'permanent' | 'template' | 'channel';

export interface GraphErrorInfo {
  code: number;
  title: string;
  httpStatus: number;
  class: GraphErrorClass;
  retryable: boolean;
  details: string;
}

// HTTP statuses as listed on Meta's Cloud API error-code page (docs/12 [R14]); every fault may override them.
const TABLE: ReadonlyArray<[number, string, number, GraphErrorClass, string]> = [
  [0, 'AuthException', 401, 'channel', 'We were unable to authenticate the app user.'],
  [3, 'API Method', 500, 'channel', 'Capability or permissions issue.'],
  [4, 'API Too Many Calls', 400, 'temporary', 'The app has reached its API call rate limit.'],
  [10, 'Permission Denied', 403, 'channel', 'Permission is either not granted or has been removed.'],
  [
    100,
    'Invalid parameter',
    400,
    'permanent',
    'The request included one or more unsupported or misspelled parameters.',
  ],
  [190, 'Access token has expired', 401, 'channel', 'Error validating access token: Session has expired.'],
  [
    368,
    'Temporarily blocked for policies violations',
    403,
    'channel',
    'The WhatsApp Business Account is restricted.',
  ],
  [80007, 'Rate limit issues', 400, 'temporary', 'The WhatsApp Business Account has reached its rate limit.'],
  [130429, 'Rate limit hit', 400, 'temporary', 'Cloud API message throughput has been reached.'],
  [131000, 'Something went wrong', 500, 'temporary', 'Message failed to send due to an unknown error.'],
  [131005, 'Access denied', 403, 'channel', 'Permission is either not granted or has been removed.'],
  [131008, 'Required parameter is missing', 400, 'permanent', 'The request is missing a required parameter.'],
  [131009, 'Parameter value is not valid', 400, 'permanent', 'One or more parameter values are invalid.'],
  [131016, 'Service unavailable', 503, 'temporary', 'A service is temporarily unavailable.'],
  [131021, 'Recipient cannot be sender', 400, 'permanent', 'Sender and recipient phone number is the same.'],
  [131026, 'Message undeliverable', 400, 'permanent', 'Unable to deliver message.'],
  [
    131031,
    'Account has been locked',
    403,
    'channel',
    'The WhatsApp Business Account has been restricted or disabled.',
  ],
  [
    131042,
    'Business eligibility payment issue',
    400,
    'channel',
    'There was an error related to your payment method.',
  ],
  [
    131045,
    'Incorrect certificate',
    400,
    'channel',
    'Message failed to send due to a phone number registration error.',
  ],
  [
    131047,
    'Re-engagement message',
    400,
    'permanent',
    'More than 24 hours have passed since the recipient last replied.',
  ],
  [
    131048,
    'Spam rate limit hit',
    400,
    'channel',
    'Message failed to send because of restrictions on the number.',
  ],
  [
    131049,
    'Meta chose not to deliver',
    400,
    'permanent',
    'This message was not delivered to maintain healthy ecosystem engagement.',
  ],
  [
    131050,
    'User stopped marketing messages',
    400,
    'permanent',
    'The recipient has chosen to stop receiving marketing messages.',
  ],
  [131051, 'Unsupported message type', 400, 'permanent', 'Unsupported message type.'],
  [
    131056,
    'Pair rate limit hit',
    400,
    'temporary',
    'Too many messages sent from the sender phone number to the same recipient in a short period.',
  ],
  [131057, 'Account in maintenance mode', 500, 'temporary', 'Business Account is in maintenance mode.'],
  [
    132000,
    'Template Param Count Mismatch',
    400,
    'permanent',
    'The number of variable parameter values does not match the template.',
  ],
  [
    132001,
    'Template does not exist',
    404,
    'template',
    'The template does not exist in the specified language or has not been approved.',
  ],
  [
    132007,
    'Template Format Character Policy Violated',
    400,
    'template',
    'Template content violates a WhatsApp policy.',
  ],
  [
    132012,
    'Template Parameter Format Mismatch',
    400,
    'permanent',
    'Variable parameter values formatted incorrectly.',
  ],
  [132015, 'Template is Paused', 400, 'template', 'Template is paused due to low quality.'],
  [
    132016,
    'Template is Disabled',
    400,
    'template',
    'Template has been paused too many times due to low quality.',
  ],
  [
    133010,
    'Phone number Not Registered',
    400,
    'channel',
    'The phone number is not registered on the WhatsApp Business Platform.',
  ],
  [
    135000,
    'Generic user error',
    400,
    'permanent',
    'Message failed to send because of an unknown error with your request parameters.',
  ],
];

const BY_CODE = new Map<number, GraphErrorInfo>(
  TABLE.map(([code, title, httpStatus, cls, details]) => [
    code,
    { code, title, httpStatus, class: cls, retryable: cls === 'temporary', details },
  ]),
);

export const RETRYABLE_CODES: readonly number[] = TABLE.filter((r) => r[3] === 'temporary').map((r) => r[0]);
export const PERMANENT_CODES: readonly number[] = TABLE.filter((r) => r[3] !== 'temporary').map((r) => r[0]);

export function graphErrorInfo(code: number): GraphErrorInfo {
  return (
    BY_CODE.get(code) ?? {
      code,
      title: 'Unknown error',
      httpStatus: 400,
      class: 'permanent',
      retryable: false,
      details: 'Simulated error.',
    }
  );
}

export function knownGraphErrors(): GraphErrorInfo[] {
  return [...BY_CODE.values()];
}

export interface GraphErrorBody {
  error: {
    message: string;
    type: string;
    code: number;
    error_data?: { messaging_product: 'whatsapp'; details: string };
    error_subcode?: number;
    fbtrace_id: string;
  };
}

export function fbtraceId(): string {
  return randomBytes(9).toString('base64url');
}

/** Error body in the Graph API shape: `{ error: { message, type, code, error_data, fbtrace_id } }`. */
export function graphErrorBody(
  code: number,
  opts: { message?: string; details?: string; subcode?: number } = {},
): GraphErrorBody {
  const info = graphErrorInfo(code);
  const body: GraphErrorBody = {
    error: {
      message: opts.message ?? `(#${code}) ${info.title}`,
      type: 'OAuthException',
      code,
      error_data: { messaging_product: 'whatsapp', details: opts.details ?? info.details },
      fbtrace_id: fbtraceId(),
    },
  };
  if (opts.subcode !== undefined) body.error.error_subcode = opts.subcode;
  return body;
}

/** Body of a bare HTTP failure (no Meta code), e.g. an upstream 5xx. */
export function bareHttpErrorBody(httpStatus: number): GraphErrorBody {
  return {
    error: {
      message: httpStatus >= 500 ? '(#2) Service temporarily unavailable' : `HTTP ${httpStatus}`,
      type: 'OAuthException',
      code: httpStatus >= 500 ? 2 : 1,
      fbtrace_id: fbtraceId(),
    },
  };
}

/** Entry of `statuses[].errors[]` in a `failed` status webhook. */
export function statusErrorEntry(code: number): {
  code: number;
  title: string;
  message: string;
  error_data: { details: string };
  href: string;
} {
  const info = graphErrorInfo(code);
  return {
    code,
    title: info.title,
    message: info.title,
    error_data: { details: info.details },
    href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
  };
}
