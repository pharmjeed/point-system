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
  trustProxySetting,
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
  // V2-021 (DEC-511): the payment gateway's webhook is read as raw bytes too — its shared secret is checked before the
  // body is parsed and the exact bytes are hashed (body_sha256)
  app.use(
    '/webhooks/payments',
    express.raw({ type: () => true, limit: '1mb' }),
    (req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
      next();
    },
  );
  // V2-040 (DEC-543): the e-invoicing provider's status callback is signed over its raw bytes
  app.use(
    '/webhooks/einvoicing',
    express.raw({ type: () => true, limit: '256kb' }),
    (req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
      next();
    },
  );
  app.useBodyParser('json', { limit: '1mb' });
  app.disable('x-powered-by');
  // the client address (rate limits by IP, audit ip) comes from X-Forwarded-For of the reverse proxy (TRUST_PROXY hops)
  app.set('trust proxy', trustProxySetting(opts.env.TRUST_PROXY));
  app.use(
    helmet({
      // the API serves JSON and text only: a CSP that allows nothing (05 §4 «CSP للـAPI بسيطة»); the web app's
      // own CSP is set by the reverse proxy on the static files (DEC-94, infra/caddy/Caddyfile)
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      // HSTS (helmet default max-age=31536000; includeSubDomains) matches 05 §14.1 and the proxy
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
