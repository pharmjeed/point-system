import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import { validateIdempotencyKey } from '../../../core/idempotency/command-runner.js';
import { CLOCK, DATABASE } from '../../../http/tokens.js';
import {
  CompleteMediaUploadUseCase,
  type MediaCompletionPlan,
} from '../application/complete-media-upload.js';

const PLAN = Symbol('media.completionPlan');

type Req = Request & { actor?: ActorContext; [PLAN]?: MediaCompletionPlan };

/**
 * The storage phase of `POST /v1/media/{mediaId}/complete`, run before the command transaction.
 *
 * The CommandInterceptor opens the command transaction (L0 idempotency claim) before the handler runs, and
 * object-storage I/O must never happen inside a transaction (ENGINEERING §2, 04 §5.3 rule 5). This route
 * guard runs after the CSRF/session/permission guards and before the interceptor: it performs the storage
 * work (`CompleteMediaUploadUseCase.prepare`) and leaves the plan on the request for the handler. It never
 * rejects — every outcome, errors included, is answered by the handler inside the command transaction, so a
 * deterministic 4xx is stored with the Idempotency-Key like any other command error and a 5xx is not.
 *
 * A request whose key is missing, malformed or already known (replay, reuse) skips the storage phase: the
 * interceptor answers it before anything else (08 §2 step 5).
 */
@Injectable()
export class MediaCompletionPreparer implements CanActivate {
  constructor(
    private readonly completion: CompleteMediaUploadUseCase,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    delete req[PLAN];
    if (!req.actor) return true;
    let key: string;
    try {
      key = validateIdempotencyKey(req.header('Idempotency-Key') ?? undefined);
    } catch {
      return true;
    }
    if (await this.isKnownKey(req.actor.userId, key)) return true;
    req[PLAN] = await this.completion.prepare(req.actor, String(req.params.mediaId ?? ''), req.body);
    return true;
  }

  private async isKnownKey(userId: string, key: string): Promise<boolean> {
    const r = await this.db.query(
      `SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND expires_at > $3`,
      [userId, key, this.clock.now()],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

/** The plan left by {@link MediaCompletionPreparer} (undefined when the storage phase was skipped). */
export const MediaCompletionPlanParam = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): MediaCompletionPlan | undefined =>
    ctx.switchToHttp().getRequest<Req>()[PLAN],
);
