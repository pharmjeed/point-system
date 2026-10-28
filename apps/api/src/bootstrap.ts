import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { requestContextMiddleware } from '@point/server';
import helmet from 'helmet';
import type { CoreModuleOptions } from './core.module.js';
import { AppModule } from './app.module.js';

/** Builds the HTTP application (used by main.ts and by the API tests). */
export async function createApp(opts: CoreModuleOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(opts), {
    rawBody: true, // the WhatsApp webhook verifies X-Hub-Signature-256 on the raw body (05 §14.3)
    bodyParser: true,
    logger: ['error', 'warn'],
  });
  app.useBodyParser('json', { limit: '1mb' });
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: false, // the API serves JSON only; the web app sets its own CSP
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(requestContextMiddleware);
  app.use(cookieParser());
  app.enableShutdownHooks();
  return app;
}
