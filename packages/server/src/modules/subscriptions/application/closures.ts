import {
  PLATFORM_REASON_MIN,
  riyadhDate,
  type PlatformVenueClosureCancelBody,
  type PlatformVenueClosureCreateBody,
  type PlatformVenueClosuresQuery,
} from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { push } from './machine.js';
import { iso, UUID } from './rows.js';

interface ClosureRow {
  id: string;
  org_id: string;
  venue_id: string;
  kind: 'holiday' | 'closure';
  starts_on: string;
  ends_on: string;
  reason_ar: string;
  created_at: Date;
  canceled_at: Date | null;
  cancel_reason: string | null;
}

const CLOSURE_COLUMNS = `c.id, c.org_id, c.venue_id, c.kind, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on,
  c.reason_ar, c.created_at, c.canceled_at, c.cancel_reason`;

const view = (c: ClosureRow) => ({
  closure_id: c.id,
  venue_id: c.venue_id,
  kind: c.kind,
  starts_on: c.starts_on,
  ends_on: c.ends_on,
  reason_ar: c.reason_ar,
  created_at: iso(c.created_at)!,
  canceled_at: iso(c.canceled_at),
  cancel_reason: c.cancel_reason,
});

/**
 * P-05 «الإجازات والإغلاقات المعلنة» (V2-036; DEC-599; annex clauses 2 and 5): a venue's scheduled holidays and the
 * closures the site announces, shown to the customer on C-08 / C-09 before payment. They change no counted day (a
 * holiday counts unless a freeze covers it); every live subscriber of the venue is told when one is announced. A
 * closure is withdrawn with a reason, never deleted. `platform.plan_manage`.
 */
export class VenueClosuresService {
  constructor(private readonly db: Database) {}

  async list(q: PlatformVenueClosuresQuery, now: Date) {
    const rows = (
      await this.db.query<ClosureRow>(
        `SELECT ${CLOSURE_COLUMNS} FROM venue_closures c
          WHERE c.venue_id = $1 ${q.include_past === 'true' ? '' : 'AND c.ends_on >= $2::date'}
          ORDER BY c.starts_on, c.id LIMIT 200`,
        q.include_past === 'true' ? [q.venue_id] : [q.venue_id, riyadhDate(now)],
      )
    ).rows;
    return { items: rows.map(view) };
  }

  async create(
    tx: Tx,
    actor: PlatformActorContext,
    body: PlatformVenueClosureCreateBody,
    client: ClientInfo,
  ) {
    const venue = await tx.maybeOne<{ id: string; org_id: string }>(
      `SELECT v.id, v.org_id FROM venues v JOIN venue_public_profiles vp ON vp.venue_id = v.id AND vp.org_id = v.org_id
        WHERE v.id = $1`,
      [body.venue_id],
    );
    if (!venue) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    if (body.ends_on < riyadhDate(tx.now))
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'ends_on', issue: 'in_the_past' }] });
    const c = await tx.one<ClosureRow>(
      `INSERT INTO venue_closures AS c (org_id, venue_id, kind, starts_on, ends_on, reason_ar, created_by, created_at,
                                        updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING ${CLOSURE_COLUMNS}`,
      [venue.org_id, venue.id, body.kind, body.starts_on, body.ends_on, body.reason_ar, actor.userId, tx.now],
    );
    // the subscribers are told (annex clause 5 «إبلاغ المشترك بالإغلاق عند العلم به»); the push names no date
    const subscribers = await tx.rows<{ id: string; account_id: string; org_id: string; venue_id: string }>(
      `SELECT id, account_id, org_id, venue_id FROM subscriptions
        WHERE venue_id = $1 AND org_id = $2 AND status IN ('pending_payment','active','frozen')
        ORDER BY id`,
      [venue.id, venue.org_id],
    );
    for (const s of subscribers) await push(tx, s, 'subscription_venue_closure', `closure:${c.id}`);
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'venue_closure.create',
      entityType: 'venue_closure',
      entityId: c.id,
      orgId: venue.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: {
        venue_id: venue.id,
        kind: c.kind,
        starts_on: c.starts_on,
        ends_on: c.ends_on,
        notified: subscribers.length,
      },
    });
    return view(c);
  }

  async cancel(
    tx: Tx,
    actor: PlatformActorContext,
    closureId: string,
    body: PlatformVenueClosureCancelBody,
    client: ClientInfo,
  ) {
    const reason = (body.reason ?? '').trim();
    if (reason.length < PLATFORM_REASON_MIN)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: PLATFORM_REASON_MIN });
    if (!UUID.test(closureId)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue_closure' });
    const c = await tx.maybeOne<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM venue_closures c WHERE c.id = $1 FOR NO KEY UPDATE`,
      [closureId],
    );
    if (!c) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue_closure' });
    if (c.canceled_at)
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'venue_closure',
        entity_id: c.id,
        current_status: 'canceled',
        command: 'venue_closure.cancel',
        allowed_from: ['announced'],
      });
    const updated = await tx.one<ClosureRow>(
      `UPDATE venue_closures c SET canceled_at = $3, canceled_by = $4, cancel_reason = $5, version = version + 1
        WHERE c.id = $1 AND c.org_id = $2 RETURNING ${CLOSURE_COLUMNS}`,
      [c.id, c.org_id, tx.now, actor.userId, reason],
    );
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'venue_closure.cancel',
      entityType: 'venue_closure',
      entityId: c.id,
      orgId: c.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason,
      metadata: { venue_id: c.venue_id },
    });
    return view(updated);
  }
}
