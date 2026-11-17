// Public surface of the complaints module (V2-037; docs/v2/01 C-21/C-22, docs/v2/02 P-13; DEC-603, DEC-604):
// complaints registered from the customer app with a reference number and followed in the platform console.
import { Module } from '@nestjs/common';
import type { Database } from '../../core/db/database.js';
import { DATABASE } from '../../http/tokens.js';
import { CustomerComplaints, PlatformComplaints } from './application/complaints.js';
import { CustomerComplaintsController, PlatformComplaintsController } from './http/complaints.controller.js';

export { CustomerComplaints, PlatformComplaints } from './application/complaints.js';

@Module({
  controllers: [CustomerComplaintsController, PlatformComplaintsController],
  providers: [
    { provide: CustomerComplaints, useFactory: () => new CustomerComplaints() },
    {
      provide: PlatformComplaints,
      inject: [DATABASE],
      useFactory: (db: Database) => new PlatformComplaints(db),
    },
  ],
})
export class ComplaintsHttpModule {}
