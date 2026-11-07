import { Module } from '@nestjs/common';
import { PlatformAuthService } from './application/platform-auth-service.js';
import { PlatformAuthController } from './http/platform-auth.controller.js';

/** V2 platform layer (docs/v2/02): `/v1/platform/*`, platform accounts and sessions apart from the staff ones. */
@Module({
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService],
  exports: [PlatformAuthService],
})
export class PlatformHttpModule {}
