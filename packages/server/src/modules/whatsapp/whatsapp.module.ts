import { Module } from '@nestjs/common';
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import type { SecretResolver } from '../../core/secrets/secret-resolver.js';
import { CLOCK, DATABASE, ENV, LOGGER, SECRETS } from '../../http/tokens.js';
import { WhatsappChannelAdmin } from './application/channel-admin.js';
import { WhatsappTemplates } from './application/templates.js';
import { WhatsappWebhookIntake } from './application/webhook-intake.js';
import { TemplateSyncPrefetchGuard, WhatsappAdminController } from './http/admin.controller.js';
import { WhatsappWebhookController } from './http/webhook.controller.js';
import { WhatsappRuntime } from './runtime.js';

/** api process: the admin channel/template routes and the webhook (PNT-038 … PNT-040). */
@Module({
  controllers: [WhatsappAdminController, WhatsappWebhookController],
  providers: [
    {
      provide: WhatsappRuntime,
      inject: [ENV, SECRETS, LOGGER],
      useFactory: (env: Env, secrets: SecretResolver, logger: Logger) =>
        new WhatsappRuntime({ env, secrets, logger: logger.child({ module: 'whatsapp' }) }),
    },
    {
      provide: WhatsappChannelAdmin,
      inject: [WhatsappRuntime],
      useFactory: (rt: WhatsappRuntime) => new WhatsappChannelAdmin(rt),
    },
    {
      provide: WhatsappTemplates,
      inject: [WhatsappRuntime],
      useFactory: (rt: WhatsappRuntime) => new WhatsappTemplates(rt),
    },
    {
      provide: WhatsappWebhookIntake,
      inject: [WhatsappRuntime, DATABASE, CLOCK],
      useFactory: (rt: WhatsappRuntime, db: Database, clock: Clock) =>
        new WhatsappWebhookIntake(rt, db, clock),
    },
    TemplateSyncPrefetchGuard,
  ],
  exports: [WhatsappRuntime, WhatsappChannelAdmin, WhatsappTemplates, WhatsappWebhookIntake],
})
export class WhatsappHttpModule {}
