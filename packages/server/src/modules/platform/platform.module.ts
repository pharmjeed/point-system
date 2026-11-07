import { Module } from '@nestjs/common';
import { PlatformAuthService } from './application/platform-auth-service.js';
import { OperatorsService } from './application/operators-service.js';
import { PlatformOperatorsController } from './http/operators.controller.js';
import { PlatformAuthController } from './http/platform-auth.controller.js';

/** V2 platform layer (docs/v2/02): `/v1/platform/*`, platform accounts and sessions apart from the staff ones. */
@Module({
  controllers: [PlatformAuthController, PlatformOperatorsController],
  providers: [PlatformAuthService, OperatorsService],
  exports: [PlatformAuthService, OperatorsService],
})
export class PlatformHttpModule {}
