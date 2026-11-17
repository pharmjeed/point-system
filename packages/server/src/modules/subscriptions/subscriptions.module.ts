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
import { VenueClosuresService } from './application/closures.js';
import { PlatformEligibilityService } from './application/eligibility.js';
import { ExceptionalRefunds } from './application/exceptional-refund.js';
import {
  PlatformEligibleStudentsController,
  PlatformPlansController,
  PlatformSubscriptionsController,
  PlatformVenueClosuresController,
} from './http/platform-subscriptions.controller.js';

/**
 * V2-030 … V2-035 (docs/v2/04 §1, §2): the subscriptions' HTTP surface — the customer's C-09/C-10/C-14 routes and the
 * platform's P-05 / P-07. The payments runtime (the gateway) is lent by the payments-online module.
 */
@Module({
  imports: [PaymentsOnlineHttpModule],
  controllers: [
    CustomerSubscriptionsController,
    PlatformPlansController,
    PlatformSubscriptionsController,
    PlatformEligibleStudentsController,
    PlatformVenueClosuresController,
  ],
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
    {
      provide: PlatformEligibilityService,
      inject: [DATABASE],
      useFactory: (db: Database) => new PlatformEligibilityService(db),
    },
    {
      provide: VenueClosuresService,
      inject: [DATABASE],
      useFactory: (db: Database) => new VenueClosuresService(db),
    },
    { provide: ExceptionalRefunds, useFactory: () => new ExceptionalRefunds() },
    SubscriptionCheckoutPreparer,
  ],
})
export class SubscriptionsHttpModule {}
