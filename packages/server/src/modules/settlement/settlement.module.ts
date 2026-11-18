import { Module } from '@nestjs/common';
import type { Clock } from '../../core/clock/clock.js';
import type { Env } from '../../core/config/env.js';
import type { Database } from '../../core/db/database.js';
import { CLOCK, DATABASE, ENV } from '../../http/tokens.js';
import { InvoicingHttpModule } from '../invoicing/index.js';
import { ListCursorCodec } from '../venues-events/index.js';
import { OperatorSettlementQueries, PlatformSettlementsQueries } from './application/reads.js';
import { SettlementCommands } from './application/statements.js';
import {
  OperatorSettlementsController,
  OperatorSystemSubscriptionController,
  PlatformSettlementsController,
} from './http/controllers.js';

/** api process (V2-041 / V2-042): P-09, O-05 and O-06. */
@Module({
  imports: [InvoicingHttpModule],
  controllers: [
    PlatformSettlementsController,
    OperatorSettlementsController,
    OperatorSystemSubscriptionController,
  ],
  providers: [
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
    {
      provide: PlatformSettlementsQueries,
      inject: [DATABASE, ListCursorCodec],
      useFactory: (db: Database, c: ListCursorCodec) => new PlatformSettlementsQueries(db, c),
    },
    {
      provide: OperatorSettlementQueries,
      inject: [DATABASE, ListCursorCodec, CLOCK],
      useFactory: (db: Database, c: ListCursorCodec, clock: Clock) =>
        new OperatorSettlementQueries(db, c, clock),
    },
    {
      provide: SettlementCommands,
      inject: [ENV],
      useFactory: (env: Env) => new SettlementCommands(() => env.VAT_RATE_BP),
    },
  ],
})
export class SettlementHttpModule {}
