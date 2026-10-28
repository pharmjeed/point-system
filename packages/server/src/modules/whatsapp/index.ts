export { WhatsappHttpModule } from './whatsapp.module.js';
export { WhatsappRuntime, defaultWhatsappRuntime, type WhatsappDeps } from './runtime.js';
export { setChannelHealth, channelDownDedupeKey } from './application/channel-health.js';
export { WhatsappChannelAdmin, WhatsappChannelPutBody } from './application/channel-admin.js';
export { WhatsappTemplates, templateStatus, templateView } from './application/templates.js';
export {
  WhatsappWebhookIntake,
  verifyHubSignature,
  constantTimeEqual,
} from './application/webhook-intake.js';
export {
  registerTicketUpdatePublisher,
  publishTicketUpdated,
  type TicketUpdatePublisher,
} from './infra/realtime.js';
export { activeChannel, channelView, type ChannelRow, type ChannelView } from './infra/channel.js';
export { GraphClient } from './infra/graph-client.js';
export {
  classifyGraphFailure,
  type WaErrorClass,
  type WaErrorClassification,
} from './domain/graph-errors.js';
