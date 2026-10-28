import { Module } from '@nestjs/common';
import type { Env } from '../../core/config/env.js';
import type { Logger } from '../../core/logging/logger.js';
import type { SecretResolver } from '../../core/secrets/secret-resolver.js';
import { ENV, LOGGER, SECRETS } from '../../http/tokens.js';
import { WhatsappChannelAdmin } from './application/channel-admin.js';
import { WhatsappTemplates } from './application/templates.js';
import { TemplateSyncPrefetchGuard, WhatsappAdminController } from './http/admin.controller.js';
import { WhatsappRuntime } from './runtime.js';

/** api process: the admin channel/template routes (PNT-038, PNT-039). */
@Module({
  controllers: [WhatsappAdminController],
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
    TemplateSyncPrefetchGuard,
  ],
  exports: [WhatsappRuntime, WhatsappChannelAdmin, WhatsappTemplates],
})
export class WhatsappHttpModule {}
