import { Module, type OnModuleInit } from '@nestjs/common';
import { startCustomerPushPlanner } from './application/customer-push.js';
import { startCustomerRealtime } from './application/customer-realtime.js';
import { MediaHttpModule } from '../media/index.js';
import { CustomerController } from './http/customer.controller.js';

/**
 * V2 customer API (docs/v2/05 §1, V2-010): `/v1/customer/*`, customer accounts and Bearer sessions apart from the
 * staff and platform identities (DEC-497). The media module lends its object storage for the presigned photos of
 * the listed locations.
 */
@Module({
  imports: [MediaHttpModule],
  controllers: [CustomerController],
})
export class CustomerAccountsHttpModule implements OnModuleInit {
  /** V2-015 / V2-016: commands of the api plan the customer pushes and `visit.updated` in their transaction. */
  onModuleInit(): void {
    startCustomerPushPlanner();
    startCustomerRealtime();
  }
}
