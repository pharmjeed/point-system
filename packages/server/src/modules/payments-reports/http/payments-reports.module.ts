import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import { deleterForStore, registerMediaObjectDeleter } from '../../../core/hooks/media-objects.js';
import type { Logger } from '../../../core/logging/logger.js';
import { CLOCK, ENV, LOGGER } from '../../../http/tokens.js';
import type { ObjectStorage } from '../../media/index.js';
import { CashHandoversService } from '../application/cash-handovers.js';
import { ExportsService } from '../application/exports.js';
import { PaymentsService } from '../application/payments.js';
import { ReportsService } from '../application/reports.js';
import {
  EXPORTS_STORAGE,
  createExportsStorage,
  registerExportsStorage,
  registeredExportsStorage,
} from '../infra/exports-storage.js';
import { ExportsController, PaymentsController, ReportsController } from './controllers.js';

/**
 * HTTP surface of payments-reports (canon §9.4 and the reports/exports of §9.7). The exports bucket client is
 * provided as EXPORTS_STORAGE (a second instance of the media module's storage, for `S3_BUCKET_EXPORTS`); the api
 * registers it for `job.export_generate` run in-process and as the `exports` deleter of `job.retention_purge`.
 */
@Module({
  controllers: [PaymentsController, ReportsController, ExportsController],
  providers: [
    {
      provide: EXPORTS_STORAGE,
      inject: [ENV, CLOCK, LOGGER],
      useFactory: (env: Env, clock: Clock, logger: Logger) => createExportsStorage(env, clock, logger),
    },
    PaymentsService,
    CashHandoversService,
    ReportsService,
    ExportsService,
  ],
  exports: [EXPORTS_STORAGE, PaymentsService],
})
export class PaymentsReportsHttpModule implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(EXPORTS_STORAGE) private readonly storage: ObjectStorage) {}

  onModuleInit(): void {
    registerExportsStorage(this.storage);
    registerMediaObjectDeleter(deleterForStore(this.storage), 'exports');
  }

  async onModuleDestroy(): Promise<void> {
    registerMediaObjectDeleter(null, 'exports');
    if (registeredExportsStorage() === this.storage) registerExportsStorage(null);
    await this.storage.close?.();
  }
}
