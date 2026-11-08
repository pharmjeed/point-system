import { Module } from '@nestjs/common';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import type { SecretResolver } from '../../core/secrets/secret-resolver.js';
import { DATABASE, ENV, LOGGER, SECRETS } from '../../http/tokens.js';
import { OnlinePayments } from './application/online-payments.js';
import { RefundsService } from './application/refunds.js';
import { PaymentWebhookIntake } from './application/webhooks.js';
import { PaymentWebhookController, PlatformRefundsController } from './http/controllers.js';
import { PaymentsRuntime } from './runtime.js';

/**
 * api process (V2-020 / V2-021): the payment gateway's webhook and the platform's refund command. The customer's
 * payment screens (V2-022, V2-023) start payments through OnlinePayments, exported here.
 */
@Module({
  controllers: [PaymentWebhookController, PlatformRefundsController],
  providers: [
    {
      provide: PaymentsRuntime,
      inject: [ENV, SECRETS, LOGGER],
      useFactory: (env: Env, secrets: SecretResolver, logger: Logger) =>
        new PaymentsRuntime({ env, secrets, logger: logger.child({ module: 'payments-online' }) }),
    },
    {
      provide: PaymentWebhookIntake,
      inject: [PaymentsRuntime, DATABASE],
      useFactory: (rt: PaymentsRuntime, db: Database) => new PaymentWebhookIntake(rt, db),
    },
    {
      provide: OnlinePayments,
      inject: [DATABASE, PaymentsRuntime],
      useFactory: (db: Database, rt: PaymentsRuntime) => new OnlinePayments(db, rt),
    },
    RefundsService,
  ],
  exports: [PaymentsRuntime, OnlinePayments],
})
export class PaymentsOnlineHttpModule {}
