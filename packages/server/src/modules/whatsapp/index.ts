export { WhatsappHttpModule } from './whatsapp.module.js';
export { whatsappJobs } from './jobs.js';
export { WhatsappRuntime, defaultWhatsappRuntime, type WhatsappDeps } from './runtime.js';

// seams for the flows built on the adapter (PNT-043 … PNT-049)
export {
  registerButtonPressHandler,
  registerLinkCodeHandler,
  registerActionTokenIssuer,
  registerW01OutcomeHandler,
  resetWhatsappSeams,
  defaultButtonPressHandler,
  defaultLinkCodeHandler,
  defaultActionTokenIssuer,
  defaultW01OutcomeHandler,
  type ButtonPressContext,
  type ButtonPressHandler,
  type ButtonPressResult,
  type LinkCodeContext,
  type LinkCodeHandler,
  type LinkCodeResult,
  type ActionTokenIssueContext,
  type ActionTokenIssuer,
  type W01OutcomeContext,
  type W01OutcomeHandler,
  type InboundMessageRef,
} from './application/seams.js';
export {
  ACTION_TOKEN_PREFIX,
  actionTokenHash,
  actionTokenState,
  findActionTokenByHash,
  issueActionToken,
  newActionToken,
  revokeActionTokens,
  sameCustomer,
  touchActionToken,
  type ActionTokenRow,
} from './application/action-tokens.js';
export { lockLiveLinkCode, newLinkCode, waMeLink, type LinkCodeRow } from './application/link-codes.js';
export {
  applyW01Outcome,
  changeWaLinkStatus,
  recordWaLinkChange,
  type WaLinkMethod,
  type WaLinkTicket,
} from './application/ticket-link.js';
// ticket ↔ conversation link (PNT-043, PNT-044, 12 §7)
export {
  assertTemplateApproved,
  assertCodeMessageSendable,
  assertChannelAvailable,
  startDirectLink,
  issueQrLinkCode,
  linkCodeQr,
  receiveLinkCode,
  confirmQrLink,
  resumeConsentByButton,
  linkCodeExpireHandler,
  type LinkCodeQr,
} from './application/link-service.js';
export {
  WhatsappLinkCommands,
  WhatsappLinkBody,
  WhatsappLinkConfirmBody,
  type WaLinkResult,
} from './application/link-commands.js';
export { optOutCustomer } from './application/opt-out.js';
export { setChannelHealth, channelDownDedupeKey } from './application/channel-health.js';
export { recordMessageStatusChange } from './application/message-status.js';
export { WhatsappChannelAdmin, WhatsappChannelPutBody } from './application/channel-admin.js';
export { WhatsappTemplates, templateStatus, templateView } from './application/templates.js';
export {
  WhatsappWebhookIntake,
  verifyHubSignature,
  constantTimeEqual,
} from './application/webhook-intake.js';
export { WhatsappInboundProcessor, waProcessInboundHandler } from './application/inbound-processor.js';
export { WhatsappSender, waSendHandler } from './application/sender.js';
export {
  registerTicketUpdatePublisher,
  publishTicketUpdated,
  type TicketUpdatePublisher,
} from './infra/realtime.js';
export {
  upsertInboundCustomer,
  phoneFromWaId,
  type CustomerRow,
  type WaSenderIdentity,
} from './infra/customers.js';
export { activeChannel, channelView, type ChannelRow, type ChannelView } from './infra/channel.js';
export { GraphClient } from './infra/graph-client.js';
export {
  classifyGraphFailure,
  type WaErrorClass,
  type WaErrorClassification,
} from './domain/graph-errors.js';
export { sendTimeSkipReason, w09VariantFor, sessionWindowOpen, type SendFacts } from './domain/send-rules.js';
export { normalizeInboundText, extractLinkCode, isOptOutKeyword } from './domain/inbound-text.js';
export { vehicleSummary, CODE_MASK } from './domain/render.js';
