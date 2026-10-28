import { Module, type OnModuleInit } from '@nestjs/common';
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { registerNotificationRule, startNotificationPlanner } from './application/planner.js';
import { whatsappCustomerRule } from './application/whatsapp-rule.js';

/** The NotificationPlanner with the WhatsApp customer rules (idempotent; api and worker both call it). */
export function registerNotificationPlanner(): void {
  registerNotificationRule(whatsappCustomerRule);
  startNotificationPlanner();
}

/**
 * api process: commands plan their customer messages in their own transaction (DEC-41). The module has
 * no routes; the notification lists are served by the tickets and monitoring modules.
 */
@Module({})
export class NotificationsHttpModule implements OnModuleInit {
  onModuleInit(): void {
    registerNotificationPlanner();
  }
}

/**
 * worker process: inbound processing and timers plan replies in their transactions. Delivery jobs belong
 * to the channels (`job.wa_send` in the whatsapp module, `job.push_send` in S5).
 */
export function notificationsJobs(): JobHandler[] {
  registerNotificationPlanner();
  return [];
}
