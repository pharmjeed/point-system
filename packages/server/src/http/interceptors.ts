import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { from, lastValueFrom, map, type Observable } from 'rxjs';
import { killPoint } from '../core/chaos/kill-points.js';
import type { Clock } from '../core/clock/clock.js';
import type { Database } from '../core/db/database.js';
import { AppError } from '../core/errors/app-error.js';
import { successEnvelope } from '../core/errors/envelope.js';
import {
  runCommand,
  runInTransaction,
  validateIdempotencyKey,
  type CommandResponse,
} from '../core/idempotency/command-runner.js';
import { requestHash } from '../core/idempotency/request-hash.js';
import type { Logger } from '../core/logging/logger.js';
import { COMMAND_KEY, RawBody, WithStatus, type CommandMeta } from './decorators.js';
import { requestLogFields, type PipelineRequest } from './middleware.js';
import { CLOCK, DATABASE, LOGGER } from './tokens.js';

const ACCEPT_OPERATION = 'POST /v1/task-offers/{offerId}/accept';

type Req = Request & {
  requestId: string;
  actor?: { userId: string; role?: string; venueId?: string | null };
  tx?: unknown;
};

/** Wraps plain handler results in `{ data, meta }` (07 §1.6). */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const res = ctx.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value) => {
        if (value instanceof RawBody) return value.body;
        if (value instanceof WithStatus) {
          res.status(value.status);
          if (value.status === 204) return undefined;
          return successEnvelope(value.data, req.requestId, this.clock.now());
        }
        if (value && typeof value === 'object' && 'data' in value && 'next_cursor' in value) {
          const { data, next_cursor } = value as { data: unknown; next_cursor: string | null };
          return successEnvelope(data, req.requestId, this.clock.now(), { next_cursor });
        }
        return successEnvelope(value ?? null, req.requestId, this.clock.now());
      }),
    );
  }
}

/**
 * Runs @Command() handlers inside one transaction with the idempotency protocol (07 §1.4): the handler gets
 * the transaction via @CurrentTx(); the response (success or deterministic 4xx) is stored with the key before
 * COMMIT and replayed byte-for-byte on retries with `Idempotent-Replayed: true`.
 */
@Injectable()
export class CommandInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<CommandMeta | undefined>(COMMAND_KEY, ctx.getHandler());
    if (!meta) return next.handle();
    const req = ctx.switchToHttp().getRequest<Req>();
    const res = ctx.switchToHttp().getResponse<Response>();
    // a route that ignores the key runs keyless whatever the client sends (CommandMeta.ignoreKey)
    const header = meta.ignoreKey ? undefined : (req.header('Idempotency-Key') ?? undefined);
    const handlerFn = async (tx: unknown) => {
      req.tx = tx;
      try {
        const value = await lastValueFrom(next.handle(), { defaultValue: null });
        if (value instanceof WithStatus) return { data: value.data, status: value.status };
        return { data: value };
      } finally {
        req.tx = undefined;
      }
    };
    // 08 §5.4: a foreign key the request named maps to RESOURCE_NOT_FOUND, one the server filled to INTERNAL_ERROR
    const pgContext = {
      operation: meta.operation,
      input: { params: req.params, query: req.query, body: req.body ?? null },
    };
    let run: Promise<CommandResponse>;
    // keys are scoped per user (idempotency_keys.user_id): public commands (login, MFA verify) run without one
    if ((meta.idempotent || header) && (req.actor?.userId || meta.idempotent)) {
      const key = validateIdempotencyKey(header);
      if (!req.actor?.userId) throw new AppError('AUTH_UNAUTHENTICATED');
      run = runCommand(
        this.db,
        {
          userId: req.actor.userId,
          idempotencyKey: key,
          operation: meta.operation,
          requestHash: requestHash(req.method, req.originalUrl.split('?')[0]!, req.body ?? null),
          requestId: req.requestId,
        },
        handlerFn as any,
        { pgContext },
      );
    } else {
      run = runInTransaction(this.db, req.requestId, handlerFn as any, { pgContext });
    }
    return from(run).pipe(
      map((r) => {
        // 17 H-03 KP-5: the accept committed, its answer not written — a retry with the key replays it (TC-017)
        if (meta.operation === ACCEPT_OPERATION && r.status === 200 && !r.replayed)
          killPoint('accept_after_commit_before_response');
        res.status(r.status);
        res.setHeader('X-Request-Id', req.requestId);
        if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
        if (r.error) {
          if (r.status === 429 || r.status === 503 || r.error.code === 'IDEMPOTENCY_IN_PROGRESS') {
            res.setHeader('Retry-After', String(r.error.options.retryAfterS ?? 1));
          }
          // 05 §7.6 fields; `route` is the canon operation of the command
          const fields = {
            ...requestLogFields(req as PipelineRequest, r.status),
            route: meta.operation,
            code: r.error.code,
          };
          if (r.status >= 500)
            this.logger.error({ ...fields, cause: String(r.error.options.cause ?? '') }, 'command failed');
          else this.logger.info(fields, 'command rejected');
        } else {
          this.logger.info(
            {
              ...requestLogFields(req as PipelineRequest, r.status),
              route: meta.operation,
              replayed: r.replayed,
            },
            'command',
          );
        }
        if (r.status === 204) return new RawBody(undefined);
        return new RawBody(r.body);
      }),
    );
  }
}
