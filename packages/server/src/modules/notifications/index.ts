export {
  NotificationsHttpModule,
  notificationsJobs,
  registerNotificationPlanner,
} from './notifications.module.js';
export {
  insertNotification,
  notificationPlanner,
  registerNotificationRule,
  registeredNotificationRules,
  startNotificationPlanner,
  stopNotificationPlanner,
  unregisterNotificationRule,
  type NotificationRule,
  type PlannedNotification,
} from './application/planner.js';
export { WA_SEND_JOB_MAX_ATTEMPTS, whatsappCustomerRule } from './application/whatsapp-rule.js';
export {
  customerMessageIntents,
  type CustomerMessageIntent,
  type CustomerMessageRefs,
  type IntentCondition,
  type PlannerEvent,
} from './domain/customer-rules.js';

// staff Web Push (PNT-072): planner, job, transport
export { staffPushIntents, type StaffPushIntent } from './domain/push-rules.js';
export {
  buildPushPayload,
  classifyPushResponse,
  nextPushAttemptDelay,
  pushDeadline,
  pushErrorCode,
  pushTtlSeconds,
  PUSH_MAX_PROVIDER_ATTEMPTS,
  type PushFacts,
  type PushResponseClass,
} from './domain/push-payload.js';
export {
  PUSH_SEND_JOB_MAX_ATTEMPTS,
  pushDedupeKey,
  roundPushKeys,
  staffPushPlanner,
  startStaffPushPlanner,
  stopStaffPushPlanner,
} from './application/push-planner.js';
export { pushFailedDedupeKey, pushSendHandler, runPushSend } from './application/push-sender.js';
export {
  createPushSender,
  DisabledPushSender,
  MemoryPushSender,
  parsePushRetryAfter,
  PUSH_HTTP_TIMEOUT_MS,
  selectPushDriver,
  WebPushSender,
  type PushSender,
  type PushSendRequest,
  type PushSendResult,
  type RecordedPush,
  type VapidConfig,
} from './infra/push-transport.js';
export { defaultPushRuntime, PushRuntime, type PushRuntimeDeps } from './infra/push-runtime.js';

// non-dispatch realtime (07 §4.3, 11 §9)
export {
  ticketUpdateRequests,
  type TicketUpdateRequest,
  type TicketMessageRef,
} from './domain/realtime-rules.js';
export {
  registerTicketSummaryProjection,
  requestTicketUpdate,
  type TicketSummaryProjection,
  type TicketSummaryView,
  type TicketUpdateOptions,
} from './application/ticket-updates.js';
export {
  notificationsRealtimePlanner,
  startNotificationsRealtime,
  stopNotificationsRealtime,
} from './application/realtime-planner.js';
export { wsPublishHandler } from './jobs/ws-publish.js';
