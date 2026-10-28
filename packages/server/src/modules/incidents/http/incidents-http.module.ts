import { Module } from '@nestjs/common';
import type { Env } from '../../../core/config/env.js';
import { ENV } from '../../../http/tokens.js';
import { ListCursorCodec } from '../../venues-events/index.js';
import { AlertsService } from '../application/alerts.service.js';
import { IncidentsService } from '../application/incidents.service.js';
import { AlertsController } from './alerts.controller.js';
import { IncidentsController } from './incidents.controller.js';

/** HTTP surface of the incidents module (canon §9.7: alerts and incidents; 04 §4.2 item 7). */
@Module({
  controllers: [AlertsController, IncidentsController],
  providers: [
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
    AlertsService,
    IncidentsService,
  ],
})
export class IncidentsHttpModule {}
