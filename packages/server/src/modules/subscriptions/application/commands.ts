import type { CustomerSubscription } from '@point/shared/customer';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import type { Env } from '../../../core/config/env.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { assertOwnVehicles, lockAccount } from './checkout.js';
import {
  auditTransition,
  endPatch,
  publishSubscriptionUpdated,
  transition,
  type SubActor,
} from './machine.js';
import { subscriptionById, SUBSCRIPTION_COLUMNS, type SubscriptionRow } from './rows.js';
import { customerSubscriptions } from './views.js';

const actorOf = (actor: CustomerActorContext, client: ClientInfo): SubActor => ({
  type: 'customer',
  accountId: actor.accountId,
  requestId: client.requestId,
  ip: client.ip ?? null,
  userAgent: client.userAgent ?? null,
});

async function ownLocked(tx: Tx, actor: CustomerActorContext, id: string): Promise<SubscriptionRow> {
  await lockAccount(tx, actor.accountId);
  const sub = await subscriptionById(tx, id, true);
  if (!sub || sub.account_id !== actor.accountId)
    throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
  return sub;
}

const notActive = (sub: SubscriptionRow, command: string) =>
  new AppError('SUBSCRIPTION_NOT_ACTIVE', { subscription_id: sub.id, current_status: sub.status, command });

async function view(tx: Tx, env: Env, accountId: string, id: string): Promise<CustomerSubscription> {
  const [v] = await customerSubscriptions(tx, env, accountId, { id, now: tx.now });
  return v!;
}

/**
 * C-14's commands (V2-032; docs/v2/04 §1, 01 R6; DEC-532), each under the account row then the subscription row
 * (FOR NO KEY UPDATE), with an Idempotency-Key:
 * - cancel: `active`/`frozen` → `cancel_at_period_end` (nothing renews; undone by resume until the end);
 *   `pending_payment` → canceled at once (`abandoned`: the checkout given up; a payment paid later is refunded);
 *   `past_due` → canceled at once (`past_due_canceled`: the period already ended unpaid, the grace stops);
 * - resume: the cancel at period end undone (`active`/`frozen`); without one it changes nothing;
 * - vehicles: the covered vehicles replaced, once per period (01 R6), 1 … the plan's `vehicles_included`.
 */
export class SubscriptionCommands {
  constructor(private readonly env: Env) {}

  async cancel(tx: Tx, actor: CustomerActorContext, id: string, client: ClientInfo) {
    const sub = await ownLocked(tx, actor, id);
    const who = actorOf(actor, client);
    if (sub.status === 'pending_payment')
      await transition(tx, sub, 'abandon', endPatch(tx, sub, 'abandoned'), who);
    else if (sub.status === 'past_due')
      await transition(tx, sub, 'past_due_cancel', endPatch(tx, sub, 'past_due_canceled'), who);
    else if (sub.status === 'active' || sub.status === 'frozen') {
      if (!sub.cancel_at_period_end) {
        const updated = await tx.one<SubscriptionRow>(
          `UPDATE subscriptions s SET cancel_at_period_end = true, cancel_requested_at = $2, version = s.version + 1
            WHERE s.id = $1 RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [sub.id, tx.now],
        );
        await auditTransition(tx, updated, 'subscription.cancel_at_period_end', who, {
          status: sub.status,
          period_end: updated.current_period_end?.toISOString() ?? null,
        });
        await publishSubscriptionUpdated(tx, updated);
      } else
        await auditTransition(tx, sub, 'subscription.cancel_at_period_end', who, {
          status: sub.status,
          noop: true,
        });
    } else throw notActive(sub, 'subscription.cancel');
    return view(tx, this.env, actor.accountId, sub.id);
  }

  async resume(tx: Tx, actor: CustomerActorContext, id: string, client: ClientInfo) {
    const sub = await ownLocked(tx, actor, id);
    const who = actorOf(actor, client);
    if (sub.status !== 'active' && sub.status !== 'frozen') throw notActive(sub, 'subscription.resume');
    if (sub.cancel_at_period_end) {
      const updated = await tx.one<SubscriptionRow>(
        `UPDATE subscriptions s SET cancel_at_period_end = false, cancel_requested_at = NULL, version = s.version + 1
          WHERE s.id = $1 RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [sub.id],
      );
      await auditTransition(tx, updated, 'subscription.resume', who, { status: sub.status });
      await publishSubscriptionUpdated(tx, updated);
    } else await auditTransition(tx, sub, 'subscription.resume', who, { status: sub.status, noop: true });
    return view(tx, this.env, actor.accountId, sub.id);
  }

  async vehicles(tx: Tx, actor: CustomerActorContext, id: string, vehicleIds: string[], client: ClientInfo) {
    const sub = await ownLocked(tx, actor, id);
    const who = actorOf(actor, client);
    if (sub.status !== 'active' && sub.status !== 'frozen' && sub.status !== 'past_due')
      throw notActive(sub, 'subscription.vehicles');
    if (vehicleIds.length > sub.vehicles_included)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'vehicle_ids', issue: 'too_many', max: sub.vehicles_included }],
      });
    await assertOwnVehicles(tx, actor.accountId, vehicleIds);
    const current = (
      await tx.rows<{ customer_vehicle_id: string }>(
        `SELECT customer_vehicle_id FROM subscription_vehicles
          WHERE subscription_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [sub.id, actor.accountId],
      )
    ).map((r) => r.customer_vehicle_id);
    const next = new Set(vehicleIds);
    const removed = current.filter((v) => !next.has(v));
    const added = vehicleIds.filter((v) => !current.includes(v));
    if (!removed.length && !added.length) {
      await auditTransition(tx, sub, 'subscription.vehicles', who, { noop: true });
      return view(tx, this.env, actor.accountId, sub.id);
    }
    // once per period (01 R6: «تغيير السيارة المشمولة مرة كل دورة»)
    if (
      sub.vehicles_changed_at &&
      sub.current_period_start &&
      sub.vehicles_changed_at >= sub.current_period_start
    )
      throw new AppError('SUBSCRIPTION_VEHICLES_LOCKED', {
        subscription_id: sub.id,
        available_at: sub.current_period_end?.toISOString() ?? null,
      });
    if (removed.length)
      await tx.query(
        `UPDATE subscription_vehicles SET removed_at = $3
          WHERE subscription_id = $1 AND customer_vehicle_id = ANY($2) AND removed_at IS NULL`,
        [sub.id, removed, tx.now],
      );
    for (const v of added)
      await tx.query(
        `INSERT INTO subscription_vehicles (subscription_id, account_id, customer_vehicle_id, added_at)
         VALUES ($1, $2, $3, $4)`,
        [sub.id, actor.accountId, v, tx.now],
      );
    const updated = await tx.one<SubscriptionRow>(
      `UPDATE subscriptions s SET vehicles_changed_at = $2, version = s.version + 1 WHERE s.id = $1
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [sub.id, tx.now],
    );
    await auditTransition(tx, updated, 'subscription.vehicles', who, {
      added: added.length,
      removed: removed.length,
    });
    await publishSubscriptionUpdated(tx, updated);
    return view(tx, this.env, actor.accountId, sub.id);
  }
}
