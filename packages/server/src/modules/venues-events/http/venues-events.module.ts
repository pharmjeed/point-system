import { Module } from '@nestjs/common';
import type { Env } from '../../../core/config/env.js';
import { ENV } from '../../../http/tokens.js';
import { DispatchPoolsService } from '../application/dispatch-pools.service.js';
import { EventsService } from '../application/events.service.js';
import { LayoutService } from '../application/layout.service.js';
import { VenuesService } from '../application/venues.service.js';
import { ListCursorCodec } from '../infra/cursor.js';
import { EventsController } from './events.controller.js';
import { LayoutController } from './layout.controller.js';
import { VenuesController } from './venues.controller.js';

/** HTTP surface of the venues-events module (canon §9.5 except shifts, start-closing, close, reconciliation, operations). */
@Module({
  controllers: [VenuesController, LayoutController, EventsController],
  providers: [
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
    VenuesService,
    DispatchPoolsService,
    LayoutService,
    EventsService,
  ],
  exports: [VenuesService, DispatchPoolsService, LayoutService, EventsService],
})
export class VenuesEventsHttpModule {}
