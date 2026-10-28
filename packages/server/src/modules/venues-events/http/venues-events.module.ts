import { Module } from '@nestjs/common';
import type { Env } from '../../../core/config/env.js';
import { ENV } from '../../../http/tokens.js';
import { DispatchPoolsService } from '../application/dispatch-pools.service.js';
import { LayoutService } from '../application/layout.service.js';
import { VenuesService } from '../application/venues.service.js';
import { ListCursorCodec } from '../infra/cursor.js';
import { LayoutController } from './layout.controller.js';
import { VenuesController } from './venues.controller.js';

/** HTTP surface of the venues-events module (canon §9.5: venues, settings, dispatch pools, layout). */
@Module({
  controllers: [VenuesController, LayoutController],
  providers: [
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
    VenuesService,
    DispatchPoolsService,
    LayoutService,
  ],
  exports: [VenuesService, DispatchPoolsService, LayoutService],
})
export class VenuesEventsHttpModule {}
