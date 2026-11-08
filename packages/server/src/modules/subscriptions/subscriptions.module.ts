import { Module } from '@nestjs/common';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import { DATABASE, ENV } from '../../http/tokens.js';
import { PaymentsOnlineHttpModule, PaymentsRuntime } from '../payments-online/index.js';
import { SubscriptionCheckout } from './application/checkout.js';
import { SubscriptionCommands } from './application/commands.js';
import { PlatformPlansService } from './application/plans.js';
import { PlatformSubscriptionsService } from './application/reports.js';
import {
  CustomerSubscriptionsController,
  SubscriptionCheckoutPreparer,
} from './http/customer-subscriptions.controller.js';
import {
  PlatformPlansController,
  PlatformSubscriptionsController,
} from './http/platform-subscriptions.controller.js';

/**
 * V2-030 … V2-035 (docs/v2/04 §1, §2): the subscriptions' HTTP surface — the customer's C-09/C-10/C-14 routes and the
 * platform's P-05 / P-07. The payments runtime (the gateway) is lent by the payments-online module.
 */
@Module({
  imports: [PaymentsOnlineHttpModule],
  controllers: [CustomerSubscriptionsController, PlatformPlansController, PlatformSubscriptionsController],
  providers: [
    {
      provide: SubscriptionCheckout,
      inject: [DATABASE, ENV, PaymentsRuntime],
      useFactory: (db: Database, env: Env, rt: PaymentsRuntime) => new SubscriptionCheckout(db, env, rt),
    },
    {
      provide: SubscriptionCommands,
      inject: [ENV],
      useFactory: (env: Env) => new SubscriptionCommands(env),
    },
    {
      provide: PlatformPlansService,
      inject: [DATABASE],
      useFactory: (db: Database) => new PlatformPlansService(db),
    },
    {
      provide: PlatformSubscriptionsService,
      inject: [DATABASE],
      useFactory: (db: Database) => new PlatformSubscriptionsService(db),
    },
    SubscriptionCheckoutPreparer,
  ],
})
export class SubscriptionsHttpModule {}
