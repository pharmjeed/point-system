import pino, { type Logger } from 'pino';
import { redact } from './redact.js';

export type { Logger };

/** JSON logs (05 §7.6). Every object logged is passed through the redaction walk. */
export function createLogger(
  opts: { level?: string; name?: string; destination?: pino.DestinationStream } = {},
): Logger {
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      name: opts.name,
      base: { service: opts.name ?? process.env.OTEL_SERVICE_NAME ?? 'point' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => redact(obj),
      },
      serializers: {
        err: pino.stdSerializers.err,
        req: (req: { method?: string; url?: string; id?: string }) => ({
          method: req.method,
          url: stripQuery(req.url),
          id: req.id,
        }),
        res: (res: { statusCode?: number }) => ({ status: res.statusCode }),
      },
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'headers.cookie', 'headers.authorization'],
        censor: '[REDACTED]',
      },
    },
    opts.destination,
  );
}

/** Query strings may carry tokens (hub.verify_token, cursors); log the path only. */
function stripQuery(url: string | undefined): string | undefined {
  return url?.split('?')[0];
}
