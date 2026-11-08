import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DiscoveryModule } from '@nestjs/core';
import {
  ApiExceptionFilter,
  AuthGuard,
  CommandInterceptor,
  CsrfGuard,
  EnvelopeInterceptor,
  HealthController,
  RateLimitGuard,
  RateLimiter,
  RouteAudit,
  UserRateLimitGuard,
} from '@point/server';
import { CoreModule, type CoreModuleOptions } from './core.module.js';
import { FEATURE_MODULES } from './features.js';

@Module({})
export class AppModule {
  static forRoot(opts: CoreModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [DiscoveryModule, CoreModule.forRoot(opts), ...FEATURE_MODULES, ...(opts.extraModules ?? [])],
      controllers: [HealthController],
      providers: [
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        // guards run in registration order: rate limit by IP → CSRF → session → permission → rate limit by
        // user/device (09 §8.1, 08 §2; PNT-096)
        RateLimiter,
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: UserRateLimitGuard },
        RouteAudit,
        // interceptors: the envelope wraps whatever the command interceptor produced
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
        { provide: APP_INTERCEPTOR, useClass: CommandInterceptor },
      ],
    };
  }
}
