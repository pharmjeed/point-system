import { Module } from '@nestjs/common';
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import type { SecretResolver } from '../../core/secrets/secret-resolver.js';
import { CLOCK, DATABASE, ENV, LOGGER, SECRETS } from '../../http/tokens.js';
import { MediaHttpModule, OBJECT_STORAGE, type ObjectStorage } from '../media/index.js';
import { ListCursorCodec } from '../venues-events/index.js';
import { PlatformInvoicesConsole } from './application/reads.js';
import {
  CustomerInvoicesController,
  EinvoiceWebhookController,
  PlatformInvoicesController,
} from './http/controllers.js';
import { InvoicingRuntime } from './runtime.js';

/**
 * api process (V2-040): P-10's reads, C-17's reads and the provider's status callback. The runtime built here is the
 * one the payments' documents are issued with in this process (`use()`); its PDFs live in the media module's private
 * bucket.
 */
@Module({
  imports: [MediaHttpModule],
  controllers: [PlatformInvoicesController, CustomerInvoicesController, EinvoiceWebhookController],
  providers: [
    {
      provide: InvoicingRuntime,
      inject: [ENV, CLOCK, SECRETS, LOGGER, OBJECT_STORAGE],
      useFactory: (env: Env, clock: Clock, secrets: SecretResolver, logger: Logger, storage: ObjectStorage) =>
        new InvoicingRuntime({
          env,
          clock,
          secrets,
          storage,
          logger: logger.child({ module: 'invoicing' }),
        }).use(),
    },
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
    {
      provide: PlatformInvoicesConsole,
      inject: [DATABASE, ListCursorCodec, InvoicingRuntime, CLOCK],
      useFactory: (db: Database, cursors: ListCursorCodec, rt: InvoicingRuntime, clock: Clock) =>
        new PlatformInvoicesConsole(db, cursors, rt.storage(), rt.env, clock),
    },
  ],
  exports: [InvoicingRuntime],
})
export class InvoicingHttpModule {}
