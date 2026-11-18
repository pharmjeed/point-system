import { Module } from '@nestjs/common';
import type { Env } from '../../core/config/env.js';
import { ENV } from '../../http/tokens.js';
import { ListCursorCodec } from '../venues-events/index.js';
import { PlatformCustomersService } from './application/customers-service.js';
import { PlatformAuthService } from './application/platform-auth-service.js';
import { OperatorsService } from './application/operators-service.js';
import { PlatformCustomersController } from './http/customers.controller.js';
import { PlatformOperatorsController } from './http/operators.controller.js';
import { PlatformAuthController } from './http/platform-auth.controller.js';

/** V2 platform layer (docs/v2/02): `/v1/platform/*`, platform accounts and sessions apart from the staff ones. */
@Module({
  controllers: [PlatformAuthController, PlatformOperatorsController, PlatformCustomersController],
  providers: [
    PlatformAuthService,
    OperatorsService,
    PlatformCustomersService,
    {
      provide: ListCursorCodec,
      useFactory: (env: Env) => new ListCursorCodec(env.SESSION_SECRET),
      inject: [ENV],
    },
  ],
  exports: [PlatformAuthService, OperatorsService],
})
export class PlatformHttpModule {}
