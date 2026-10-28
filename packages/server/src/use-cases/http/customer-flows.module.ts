import { Module } from '@nestjs/common';
import { ClaimCodeHookRegistrar, ResendHandoverCodeUseCase } from '../customer-flows/handover-codes.js';
import { ChangeCustomerPhoneUseCase } from '../customer-flows/linking.js';
import { CustomerFlowsController } from './customer-flows.controller.js';

/**
 * HTTP surface of the S3 customer flows (PNT-047, PNT-049) and the api-side registration of the claim code
 * hook (needs CODE_PEPPER / DATA_ENCRYPTION_KEY). The linking routes (`/whatsapp-link`, `/confirm`) live in
 * the whatsapp module, which owns link codes and consents (04 §4.2).
 */
@Module({
  controllers: [CustomerFlowsController],
  providers: [ClaimCodeHookRegistrar, ChangeCustomerPhoneUseCase, ResendHandoverCodeUseCase],
})
export class CustomerFlowsHttpModule {}
