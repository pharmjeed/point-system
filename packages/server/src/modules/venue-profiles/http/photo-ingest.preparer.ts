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
import { OperatorProfileService } from '../application/operator-profile.service.js';
import { VenuePhotoIngest, type PhotoIngestPlan } from '../application/photo-ingest.js';

const PLAN = Symbol('venueProfile.photoPlan');

type Req = Request & { actor?: ActorContext; [PLAN]?: PhotoIngestPlan };

/**
 * The storage phase of `PUT /v1/venues/{venueId}/public-profile` (DEC-494), like the media completion preparer
 * (PNT-027): it runs after the session/permission guards and before the CommandInterceptor opens the transaction,
 * sanitizes the photos the body names and leaves the plan on the request. It never rejects. It does nothing for a
 * venue outside the caller's organization (the handler answers RESOURCE_NOT_FOUND without touching the bucket),
 * nor for a request whose Idempotency-Key is missing, malformed or already known (the interceptor answers those).
 */
@Injectable()
export class PhotoIngestPreparer implements CanActivate {
  constructor(
    private readonly ingest: VenuePhotoIngest,
    private readonly profiles: OperatorProfileService,
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
    const venueId = String(req.params.venueId ?? '');
    const ids = this.profiles.photoIdsToVerify(req.actor, venueId, req.body);
    if (!ids) return true;
    const known = await this.db.query(
      `SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND expires_at > $3`,
      [req.actor.userId, key, this.clock.now()],
    );
    if ((known.rowCount ?? 0) > 0) return true;
    req[PLAN] = await this.ingest.prepare(req.actor.orgId, venueId, ids);
    return true;
  }
}

/** The plan left by {@link PhotoIngestPreparer} (undefined when the storage phase was skipped). */
export const PhotoIngestPlanParam = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): PhotoIngestPlan | undefined =>
    ctx.switchToHttp().getRequest<Req>()[PLAN],
);
