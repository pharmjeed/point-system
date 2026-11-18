import { Module } from '@nestjs/common';
import { ClaimCodeHookRegistrar, ResendHandoverCodeUseCase } from '../customer-flows/handover-codes.js';
import { HandoverExceptionUseCase } from '../customer-flows/handover-exception.js';
import { ChangeCustomerPhoneUseCase } from '../customer-flows/linking.js';
import { CustomerFlowsController } from './customer-flows.controller.js';
import { CustomerVisitsController } from './customer-visits.controller.js';
import { MediaHttpModule } from '../../modules/media/index.js';

/**
 * HTTP surface of the S3 customer flows (PNT-047, PNT-049, PNT-078) and the api-side registration of the
 * claim code hook (needs CODE_PEPPER / DATA_ENCRYPTION_KEY). The linking routes (`/whatsapp-link`,
 * `/confirm`) live in the whatsapp module, which owns link codes and consents (04 §4.2).
 */
@Module({
  // V2-015 / V2-016: the customer app's visits and push registration (DEC-516 … DEC-520); the media module lends
  // its object storage for the presigned inspection photos of C-12
  imports: [MediaHttpModule],
  controllers: [CustomerFlowsController, CustomerVisitsController],
  providers: [
    ClaimCodeHookRegistrar,
    ChangeCustomerPhoneUseCase,
    ResendHandoverCodeUseCase,
    HandoverExceptionUseCase,
  ],
})
export class CustomerFlowsHttpModule {}
