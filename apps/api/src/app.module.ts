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
  RouteAudit,
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
        // guards run in registration order: CSRF → session → permission (09 §8.1)
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        RouteAudit,
        // interceptors: the envelope wraps whatever the command interceptor produced
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
        { provide: APP_INTERCEPTOR, useClass: CommandInterceptor },
      ],
    };
  }
}
