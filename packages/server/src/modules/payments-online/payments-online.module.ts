import { Module } from '@nestjs/common';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import type { Logger } from '../../core/logging/logger.js';
import type { SecretResolver } from '../../core/secrets/secret-resolver.js';
import { DATABASE, ENV, LOGGER, SECRETS } from '../../http/tokens.js';
import { OnlinePayments } from './application/online-payments.js';
import { RefundsService } from './application/refunds.js';
import { PaymentWebhookIntake } from './application/webhooks.js';
import {
  PaymentWebhookController,
  PlatformAlertsController,
  PlatformReconciliationController,
  PlatformRefundsController,
} from './http/controllers.js';
import { PlatformPaymentsConsole } from './application/platform-console.js';
import { ListCursorCodec } from '../venues-events/index.js';
import { PaymentsRuntime } from './runtime.js';

/**
 * api process (V2-020 / V2-021, V2-024): the payment gateway's webhook, the platform's refund command and P-08's reads
 * (payments, reconciliation runs, finance alerts and their resolution). The customer's
 * payment screens (V2-022, V2-023) start payments through OnlinePayments, exported here.
 */
@Module({
  controllers: [
    PaymentWebhookController,
    PlatformRefundsController,
    PlatformReconciliationController,
    PlatformAlertsController,
  ],
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
    PlatformPaymentsConsole,
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
  ],
  exports: [PaymentsRuntime, OnlinePayments],
})
export class PaymentsOnlineHttpModule {}
