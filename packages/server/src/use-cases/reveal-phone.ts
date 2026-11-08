import { Injectable } from '@nestjs/common';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import { maskPhone } from '../core/logging/redact.js';
import { orgSettings } from '../core/settings/settings-service.js';
import { scopeStillGranted } from '../modules/incidents/index.js';
import { auditCommand } from './shared.js';

const OPERATION = 'POST /v1/tickets/{ticketId}/reveal-phone';
const WINDOW_MS = 3600_000;

/**
 * `POST /v1/tickets/{ticketId}/reveal-phone` (PNT-077; 09 §5.1 rule 2, §11; canon §12
 * `security.reveal_phone_per_hour`). Staff only (`ticket.reveal_phone`), a reason, at most N reveals per user in
 * any rolling hour (RATE_LIMITED with Retry-After), one audit row `ticket.reveal_phone` with the reason and the
 * counter — never the number. The full number appears only in this response (`Cache-Control: no-store`); the
 * copy kept with the Idempotency-Key for replays is masked before COMMIT, so the database holds it nowhere new.
 */
@Injectable()
export class RevealPhoneUseCase {
  async execute(tx: Tx, actor: ActorContext, ticketId: string, body: { reason: string }, requestId: string) {
    // FOR SHARE: the customer link cannot change under the read (phone change locks the ticket)
    const t = await tx.maybeOne<{ id: string; org_id: string; venue_id: string; customer_id: string | null }>(
      `SELECT id, org_id, venue_id, customer_id FROM tickets WHERE id = $1 AND org_id = $2 FOR SHARE`,
      [ticketId, actor.orgId],
    );
    if (!t || !actor.venueIds.has(t.venue_id)) throw new AppError('TICKET_NOT_FOUND');
    if (!(await scopeStillGranted(tx, actor, t.venue_id))) throw new AppError('TICKET_NOT_FOUND');

    // the per-user counter is serialized by a transaction-scoped advisory lock: parallel reveals never overshoot
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`reveal_phone:${actor.userId}`]);
    const limit = (await orgSettings(tx, actor.orgId)).security.reveal_phone_per_hour;
    const since = new Date(tx.now.getTime() - WINDOW_MS);
    const used = await tx.rows<{ occurred_at: Date }>(
      `SELECT occurred_at FROM audit_log
        WHERE org_id = $1 AND actor_id = $2 AND action = 'ticket.reveal_phone' AND occurred_at > $3
        ORDER BY occurred_at`,
      [actor.orgId, actor.userId, since],
    );
    if (used.length >= limit) {
      // the reveal that has to leave the window before another one is allowed
      const oldest = new Date(used[used.length - limit]!.occurred_at);
      const retryAfterS = Math.max(1, Math.ceil((oldest.getTime() + WINDOW_MS - tx.now.getTime()) / 1000));
      throw new AppError('RATE_LIMITED', { retry_after_s: retryAfterS }, { retryAfterS });
    }

    const c = t.customer_id
      ? await tx.maybeOne<{ phone_e164: string | null }>(`SELECT phone_e164 FROM customers WHERE id = $1`, [
          t.customer_id,
        ])
      : null;
    // a paper ticket, or a WhatsApp customer known only by a business-scoped id (DEC-35): nothing to reveal
    if (!c?.phone_e164) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'customer' });
    const phone = c.phone_e164;

    await auditCommand(tx, actor, {
      action: 'ticket.reveal_phone',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason: body.reason.trim(),
      metadata: {
        customer_id: t.customer_id,
        reveals_in_window: used.length + 1,
        reveal_phone_per_hour: limit,
      },
    });
    // 09 §5.1: the stored replay of this response carries the masked number only
    tx.onBeforeCommit(async () => {
      await tx.query(
        `UPDATE idempotency_keys
            SET response_body = jsonb_set(response_body, '{data,phone_e164}', to_jsonb($3::text))
          WHERE user_id = $1 AND operation = $2 AND response_body #>> '{data,phone_e164}' = $4`,
        [actor.userId, OPERATION, maskPhone(phone), phone],
      );
    }, `reveal_phone_replay:${t.id}`);
    return { phone_e164: phone, revealed_at: tx.now.toISOString() };
  }
}
