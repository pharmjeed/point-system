// Wire types shared by the simulator server and SimulatorClient (control API under /_sim).

export type StatusName = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * How a status sequence is emitted.
 * natural: sent → delivered → read · reversed: read → delivered → sent ·
 * duplicated: every status twice (identical bodies) · reorder: read → sent → delivered (docs/12 §11.4) ·
 * shuffled: random permutation.
 */
export type StatusOrder = 'natural' | 'reversed' | 'duplicated' | 'reorder' | 'shuffled';

/** valid: correct X-Hub-Signature-256 · invalid: signed with a wrong secret · missing: no header. */
export type SignatureMode = 'valid' | 'invalid' | 'missing';

/**
 * How `copies > 1` of one inbound message are produced.
 * same_body: byte-identical bodies (Meta redelivery) · same_wamid: same message id, different raw bodies ·
 * distinct: a new wamid per copy (real repeated taps).
 */
export type DuplicateMode = 'same_body' | 'same_wamid' | 'distinct';

export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';
export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';

export interface TemplateButton {
  type: string;
  text: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: TemplateStatus;
  /** Canon purpose (W-01 … W-08) when the name belongs to the local catalog. */
  purpose: string | null;
  body: string;
  bodyParamCount: number;
  buttons: TemplateButton[];
  rejectedReason: string | null;
}

export interface SentButton {
  index: number;
  subType: string;
  /** The quick-reply payload sent by the business (the action token for W-01). */
  payload: string | null;
  /** Button label from the template definition. */
  text: string | null;
}

export interface EmittedStatus {
  status: StatusName;
  at: string;
  errorCode?: number;
}

export interface OutboundMessage {
  wamid: string;
  seq: number;
  apiVersion: string;
  phoneNumberId: string;
  /** `to` exactly as sent (null when only `recipient` was used). */
  to: string | null;
  /** `recipient` (BSUID) as sent, if any (DEC-35). */
  recipient: string | null;
  /** Normalized digits of the recipient phone, when known. */
  waId: string | null;
  /** BSUID of the recipient (explicit `recipient` or derived from the phone). */
  userId: string | null;
  /** Conversation key: waId when known, otherwise userId. */
  conversation: string;
  type: string;
  templateName: string | null;
  templateLanguage: string | null;
  purpose: string | null;
  bodyParams: string[];
  buttons: SentButton[];
  text: string | null;
  /** What the customer sees (template body with parameters, or the text body). */
  renderedText: string | null;
  contextMessageId: string | null;
  bizOpaqueCallbackData: string | null;
  /** Planned asynchronous failure (status `failed`) — number rule 0000 or an async fault. */
  plannedFailure: { code: number } | null;
  acceptedAt: string;
  statuses: EmittedStatus[];
  /** The request body as received. */
  request: unknown;
}

export interface InboundMessage {
  wamid: string;
  seq: number;
  type: 'text' | 'button' | 'interactive' | 'raw';
  from: string | null;
  userId: string | null;
  conversation: string;
  bsuidOnly: boolean;
  text: string | null;
  buttonPayload: string | null;
  buttonText: string | null;
  contextId: string | null;
  timestamp: string;
  at: string;
}

export interface SendAttempt {
  seq: number;
  at: string;
  path: string;
  to: string | null;
  recipient: string | null;
  type: string | null;
  templateName: string | null;
  httpStatus: number | null;
  errorCode: number | null;
  wamid: string | null;
  /** fault | channel | number_rule | validation | auth | null */
  cause: string | null;
}

export interface WebhookDelivery {
  id: number;
  kind: string;
  url: string | null;
  at: string;
  signature: SignatureMode;
  bodySha256: string;
  wamids: string[];
  attempts: number;
  httpStatus: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

export interface EmitResult {
  /** Message ids carried by the emitted webhook bodies (inbound wamids or status targets). */
  wamids: string[];
  deliveries: WebhookDelivery[];
  /** Parsed payloads, one per distinct body. */
  payloads: unknown[];
}

export interface FaultMatch {
  /** Phone (any format) or BSUID; compared on digits for phones. */
  to?: string;
  template?: string;
  purpose?: string;
  type?: string;
}

export interface FaultRule {
  /** Graph error code (131056, 130429, 131026, 132001, 190 …). Omit with `httpStatus` for a bare HTTP error. */
  code?: number;
  /** HTTP status of the error answer; defaults from the error table (500 for a bare error). */
  httpStatus?: number;
  /** error (default) answers with an error; timeout holds the request without answering. */
  kind?: 'error' | 'timeout';
  /** sync (default): HTTP error now. async: 200 + wamid, then a `failed` status webhook with `code`. */
  mode?: 'sync' | 'async';
  /** Number of matching sends affected (default 1) or 'unlimited'. */
  count?: number | 'unlimited';
  match?: FaultMatch;
  message?: string;
  details?: string;
  /** Extra latency added to the affected sends. */
  latencyMs?: number;
}

export interface ActiveFault extends FaultRule {
  id: number;
  remaining: number | 'unlimited';
  hits: number;
}

export interface ChannelSetting {
  state: 'up' | 'down' | 'timeout';
  /** Graph error code answered while down (default 131016, HTTP 503). */
  code?: number;
  httpStatus?: number;
  /** Auto-recover after this many milliseconds. */
  durationMs?: number;
}

export interface ChannelState {
  state: 'up' | 'down' | 'timeout';
  code: number | null;
  httpStatus: number | null;
  until: string | null;
}

export interface FaultsView {
  rules: ActiveFault[];
  channel: ChannelState;
  latencyMs: number;
  statusDelayOverride: { delayMs: number; remaining: number } | null;
}

export interface SimulatorConfigView {
  webhookUrl: string | null;
  appSecretSet: boolean;
  verifyTokenSet: boolean;
  accessTokenSet: boolean;
  phoneNumberId: string | null;
  effectivePhoneNumberId: string;
  wabaId: string;
  displayPhoneE164: string;
  autoStatuses: boolean;
  statusDelayMs: number;
  statusOrder: StatusOrder;
  statusSequence: StatusName[];
  webhookRetries: number;
  webhookRetryDelayMs: number;
  webhookTimeoutMs: number;
  templateApprovalDelayMs: number;
  deterministicFaults: boolean;
  includeUserIds: boolean;
  hangMs: number;
}

export interface SimulatorConfigPatch {
  webhookUrl?: string | null;
  appSecret?: string;
  verifyToken?: string | null;
  accessToken?: string | null;
  phoneNumberId?: string | null;
  wabaId?: string;
  displayPhoneE164?: string;
  autoStatuses?: boolean;
  statusDelayMs?: number;
  statusOrder?: StatusOrder;
  statusSequence?: StatusName[];
  webhookRetries?: number;
  webhookRetryDelayMs?: number;
  webhookTimeoutMs?: number;
  templateApprovalDelayMs?: number;
  deterministicFaults?: boolean;
  includeUserIds?: boolean;
  hangMs?: number;
}

/** Common options of every inbound (customer → business) emission. */
export interface InboundOptions {
  /** Sender phone (any format, e.g. +966551234567). */
  from?: string;
  /** Sender BSUID; derived from the phone when omitted. */
  userId?: string;
  /** Omit `from`/`wa_id` and send only `user_id` (DEC-35). Default: true for numbers ending in 2222. */
  bsuidOnly?: boolean;
  profileName?: string;
  /** Message timestamp: unix seconds (number or numeric string) or an ISO date. Default: now. */
  timestamp?: number | string;
  copies?: number;
  /** Concurrency for copies (default 1 = sequential). */
  parallel?: number;
  duplicateMode?: DuplicateMode;
  /** same_wamid only: the first N copies are byte-identical, the rest vary (default 1). dup10 uses N = copies / 2. */
  identicalFirst?: number;
  /** Delay between sequential copies. */
  delayMs?: number;
  signature?: SignatureMode;
  /** Override the webhook target for this emission. */
  webhookUrl?: string;
  /** Override metadata.phone_number_id. */
  phoneNumberId?: string;
}

/** Selects a previously sent (outbound) message. */
export interface MessageSelector {
  wamid?: string;
  /** Recipient phone or BSUID. */
  to?: string;
  template?: string;
  purpose?: string;
  /** Ticket number = first body parameter of the template (W-01: {{2}}). */
  ticketNumber?: string;
  /** Pick the n-th match (0 = oldest); default: latest. */
  index?: number;
}

export interface PressOptions extends InboundOptions, MessageSelector {
  buttonIndex?: number;
  /** Send this payload instead of the stored one (forged / unknown token tests). */
  payloadOverride?: string;
  /** Omit context.id (button without the quoted message). */
  omitContext?: boolean;
}

export interface TextOptions extends InboundOptions {
  body: string;
  contextWamid?: string;
}

export interface InteractiveOptions extends InboundOptions {
  id: string;
  title: string;
  contextWamid?: string;
}

export interface StatusOptions extends MessageSelector {
  /** Default: planned outcome of the message (failed when a failure is planned, else sent/delivered/read). */
  statuses?: StatusName[];
  order?: StatusOrder;
  /** Error code for `failed` (default: planned failure code, else 131026). */
  errorCode?: number;
  copies?: number;
  delayMs?: number;
  timestamp?: number | string;
  signature?: SignatureMode;
  webhookUrl?: string;
  /** Include the pricing object (default true on `sent`). */
  pricing?: boolean;
}

export interface RawWebhookOptions {
  body: unknown;
  copies?: number;
  parallel?: number;
  signature?: SignatureMode;
  webhookUrl?: string;
}

export interface MessageFilter {
  to?: string;
  template?: string;
  purpose?: string;
  type?: string;
  phoneNumberId?: string;
  afterSeq?: number;
}

export interface ClaimCodeResult {
  code: string;
  wamid: string;
  ticketNumber: string | null;
  source: 'template' | 'text';
  seq: number;
}

export interface ConversationSummary {
  key: string;
  waId: string | null;
  userId: string | null;
  outbound: number;
  inbound: number;
  lastAt: string | null;
  /** Handover code of the latest W-05 in the conversation (dev page). */
  claimCode: string | null;
}

export interface ConversationItem {
  direction: 'out' | 'in';
  seq: number;
  at: string;
  wamid: string;
  kind: string;
  text: string | null;
  templateName: string | null;
  purpose: string | null;
  buttons: SentButton[];
  status: StatusName | null;
  claimCode: string | null;
}

export interface Conversation extends ConversationSummary {
  items: ConversationItem[];
}

export interface VerifyWebhookResult {
  ok: boolean;
  httpStatus: number | null;
  body: string | null;
  challenge: string;
  error: string | null;
}

export type ScenarioStep =
  | ({ action: 'press' } & PressOptions)
  | ({ action: 'text' } & TextOptions)
  | ({ action: 'link_code'; code: string } & InboundOptions)
  | ({ action: 'stop'; keyword?: string } & InboundOptions)
  | ({ action: 'interactive' } & InteractiveOptions)
  | ({ action: 'statuses' } & StatusOptions)
  | ({ action: 'raw' } & RawWebhookOptions)
  | ({ action: 'fault' } & FaultRule)
  | { action: 'clear_faults' }
  | ({ action: 'channel' } & ChannelSetting)
  | { action: 'latency'; ms: number }
  | { action: 'wait'; ms: number }
  | ({ action: 'config' } & SimulatorConfigPatch)
  | { action: 'status_delay'; delayMs: number; count?: number }
  | { action: 'scenario'; name: string; params?: Record<string, unknown> };

export interface ScenarioDocument {
  name?: string;
  description?: string;
  steps: ScenarioStep[];
}

export interface ScenarioStepResult {
  index: number;
  action: string;
  result: unknown;
}

export interface ScenarioResult {
  name: string;
  steps: ScenarioStepResult[];
  deliveries: WebhookDelivery[];
  wamids: string[];
}
