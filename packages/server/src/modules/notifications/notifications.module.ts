import { Module, type OnModuleInit } from '@nestjs/common';
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { registerNotificationRule, startNotificationPlanner } from './application/planner.js';
import { startStaffPushPlanner } from './application/push-planner.js';
import { pushSendHandler } from './application/push-sender.js';
import { startNotificationsRealtime } from './application/realtime-planner.js';
import { whatsappCustomerRule } from './application/whatsapp-rule.js';
import { defaultPushRuntime, PushRuntime } from './infra/push-runtime.js';
import { wsPublishHandler } from './jobs/ws-publish.js';

/**
 * The transaction planners of the module (idempotent; api and worker both call it): the customer
 * NotificationPlanner (WhatsApp rules), the staff push planner (14 §6) and the non-dispatch realtime
 * planner (`ticket.updated`, `sync.required`, `channel.status`, `incident.updated`).
 */
export function registerNotificationPlanner(): void {
  registerNotificationRule(whatsappCustomerRule);
  startNotificationPlanner();
  startStaffPushPlanner();
  startNotificationsRealtime();
}

/**
 * api process: commands plan their customer messages, staff pushes and realtime messages in their own
 * transaction (DEC-41, DEC-48). The module has no routes; the notification lists are served by the
 * tickets and monitoring modules.
 */
@Module({})
export class NotificationsHttpModule implements OnModuleInit {
  onModuleInit(): void {
    registerNotificationPlanner();
  }
}

/**
 * worker process: the planners for the worker's transactions (inbound processing, timers) and the jobs of
 * the module: `job.push_send` (Web Push, `mode: external`) and the `job.ws_publish` fallback. The push
 * runtime is built lazily from the validated process environment unless one is given (tests).
 */
export function notificationsJobs(opts: { push?: PushRuntime | (() => PushRuntime) } = {}): JobHandler[] {
  registerNotificationPlanner();
  const given = opts.push;
  const runtime =
    given instanceof PushRuntime ? () => given : typeof given === 'function' ? given : defaultPushRuntime;
  return [pushSendHandler(runtime), wsPublishHandler];
}
