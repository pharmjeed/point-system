import { Module } from '@nestjs/common';
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
export class CustomerAccountsHttpModule {}
