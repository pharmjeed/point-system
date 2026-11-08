import { Module } from '@nestjs/common';
import { AdminService } from './application/admin-service.js';
import { AuthService } from './application/auth-service.js';
import { MeService } from './application/me-service.js';
import { AdminController } from './http/admin.controller.js';
import { AuthController } from './http/auth.controller.js';

@Module({
  controllers: [AuthController, AdminController],
  providers: [AuthService, MeService, AdminService],
  exports: [AuthService, MeService, AdminService],
})
export class IdentityAccessHttpModule {}
