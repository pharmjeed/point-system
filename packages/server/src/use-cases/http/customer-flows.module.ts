import { Module } from '@nestjs/common';
import { ChangeCustomerPhoneUseCase } from '../customer-flows/linking.js';
import { CustomerFlowsController } from './customer-flows.controller.js';

/**
 * HTTP surface of the S3 customer flows (PNT-049). The linking routes (`/whatsapp-link`, `/confirm`) live in
 * the whatsapp module, which owns link codes and consents (04 §4.2).
 */
@Module({
  controllers: [CustomerFlowsController],
  providers: [ChangeCustomerPhoneUseCase],
})
export class CustomerFlowsHttpModule {}
