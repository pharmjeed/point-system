import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  CLOCK,
  DATABASE,
  ENV,
  LOGGER,
  MeService,
  RealtimeServer,
  TelemetryIngest,
  requestContextMiddleware,
  type Clock,
  type Database,
  type Env,
  type Logger,
} from '@point/server';
import helmet from 'helmet';
import type { CoreModuleOptions } from './core.module.js';
import { AppModule } from './app.module.js';

const REALTIME = new WeakMap<object, RealtimeServer>();

/** The realtime server attached to an app built by createApp (tests). */
export const realtimeOf = (app: object) => REALTIME.get(app);

/** Builds the HTTP application (used by main.ts and by the API tests). */
export async function createApp(opts: CoreModuleOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(opts), {
    rawBody: true, // the WhatsApp webhook verifies X-Hub-Signature-256 on the raw body (05 §14.3)
    bodyParser: true,
    logger: ['error', 'warn'],
  });
  // 12 §6.2: the WhatsApp webhook is read as raw bytes (signature first, JSON parsed by the worker) up to 3 MB,
  // since a delivery may batch up to 1000 updates; every other JSON body stays at 1 MB (DEC-130)
  app.use(
    '/webhooks/whatsapp',
    express.raw({ type: () => true, limit: '3mb' }),
    (req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
      next();
    },
  );
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

  // Socket.IO on /ws relays what committed transactions publish with pg_notify (DEC-48)
  const me = app.get(MeService, { strict: false });
  const telemetry = app.get(TelemetryIngest, { strict: false });
  const realtime = new RealtimeServer({
    db: app.get<Database>(DATABASE),
    clock: app.get<Clock>(CLOCK),
    env: app.get<Env>(ENV),
    logger: app.get<Logger>(LOGGER),
    heartbeat: (tx, actor, body) => me.heartbeat(tx, actor, body),
    // 15 §9.4: the WS sighting writes offer_card_seen in the same transaction as seen_at
    offerSeen: (tx, actor, payload) => telemetry.recordOfferSeen(tx, actor, payload),
  });
  await realtime.attach(app.getHttpServer());
  const close = app.close.bind(app);
  app.close = async () => {
    await realtime.close();
    return close();
  };
  REALTIME.set(app, realtime);
  return app;
}
