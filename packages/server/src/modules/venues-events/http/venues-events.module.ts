import { Module } from '@nestjs/common';
import type { Env } from '../../../core/config/env.js';
import { ENV } from '../../../http/tokens.js';
import { DispatchPoolsService } from '../application/dispatch-pools.service.js';
import { EventsService } from '../application/events.service.js';
import { LayoutService } from '../application/layout.service.js';
import { OrgSettingsService } from '../application/org-settings.service.js';
import { ShiftsService } from '../application/shifts.service.js';
import { VenuesService } from '../application/venues.service.js';
import { ListCursorCodec } from '../infra/cursor.js';
import { EventsController } from './events.controller.js';
import { LayoutController } from './layout.controller.js';
import { OrgSettingsController } from './org-settings.controller.js';
import { ShiftsController } from './shifts.controller.js';
import { VenuesController } from './venues.controller.js';

/**
 * HTTP surface of the venues-events module (canon §9.5 except start-closing, close, reconciliation, operations) and
 * the organization settings of §9.7 (`/v1/admin/org-settings`, 04 §4.2 item 2).
 */
@Module({
  controllers: [
    VenuesController,
    LayoutController,
    EventsController,
    ShiftsController,
    OrgSettingsController,
  ],
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
    ShiftsService,
    OrgSettingsService,
  ],
  exports: [VenuesService, DispatchPoolsService, LayoutService, EventsService, ShiftsService],
})
export class VenuesEventsHttpModule {}
