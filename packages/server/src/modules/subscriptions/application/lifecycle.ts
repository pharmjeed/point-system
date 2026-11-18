import { OPERATOR_BLOCKED_STATUSES, type SubscriptionFrozenReason } from '@point/shared';
import {
  registerSubscriptionLifecycleHook,
  type SubscriptionLifecycleHook,
} from '../../../core/hooks/subscription-lifecycle.js';
import type { Tx } from '../../../core/db/tx.js';
import { endPatch, freeze, push, terminate, transition, unfreeze, type SubActor } from './machine.js';
import { policyOf, SUBSCRIPTION_COLUMNS, type SubscriptionRow } from './rows.js';

const blocked = (status: string) => (OPERATOR_BLOCKED_STATUSES as readonly string[]).includes(status);

async function lockLive(
  tx: Tx,
  where: { orgId: string; venueId?: string; accountId?: string },
  statuses: readonly string[],
): Promise<SubscriptionRow[]> {
  const params: unknown[] = [statuses];
  const conds = ['s.status = ANY($1)'];
  if (where.accountId) {
    params.push(where.accountId);
    conds.push(`s.account_id = $${params.length}`);
  } else {
    params.push(where.orgId);
    conds.push(`s.org_id = $${params.length}`);
  }
  if (where.venueId) {
    params.push(where.venueId);
    conds.push(`s.venue_id = $${params.length}`);
  }
  return tx.rows<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions s WHERE ${conds.join(' AND ')} ORDER BY s.id FOR NO KEY UPDATE`,
    params,
  );
}

/** The venue of a subscription is out of service (`venues.status`), read under the caller's locks. */
async function venueInactive(tx: Tx, sub: Pick<SubscriptionRow, 'venue_id' | 'org_id'>): Promise<boolean> {
  const r = await tx.one<{ status: string }>(`SELECT status FROM venues WHERE id = $1 AND org_id = $2`, [
    sub.venue_id,
    sub.org_id,
  ]);
  return r.status !== 'active';
}

async function operatorBlocked(tx: Tx, orgId: string): Promise<boolean> {
  const r = await tx.one<{ operator_status: string }>(
    `SELECT operator_status FROM organizations WHERE id = $1`,
    [orgId],
  );
  return blocked(r.operator_status);
}

/**
 * A frozen subscription whose own reason is gone: unfrozen with its days added (DEC-536) — unless the other reason
 * holds (a venue closed while its operator was suspended, or the reverse), then it stays frozen under that one.
 */
async function release(
  tx: Tx,
  sub: SubscriptionRow,
  other: SubscriptionFrozenReason | null,
  actor: SubActor,
) {
  if (other) {
    await tx.query(`UPDATE subscriptions SET frozen_reason = $2, version = version + 1 WHERE id = $1`, [
      sub.id,
      other,
    ]);
    return;
  }
  await unfreeze(tx, sub, actor);
}

/**
 * V2-034 (docs/v2/04 §1, 02 §4; DEC-536): the operator's lifecycle and the venue's status in the subscription
 * machine, inside the transaction of the command that changed them (the organization row or the venue row locked
 * first, then the subscriptions by id):
 * - operator suspended → its venues' `active` subscriptions frozen (`operator_suspended`); reactivated → unfrozen
 *   with the frozen days added to the period (a venue still closed keeps them frozen as `venue_inactive`);
 * - operator terminated → every live subscription of its venues canceled (`operator_terminated`) with the unused
 *   share of the paid period refunded pro rata (`subscription_prorated`);
 * - venue inactive → its `active` subscriptions frozen (`venue_inactive`); active again → unfrozen likewise;
 * - account deleted (C-20) → every live subscription of the account canceled (`account_deleted`), no refund.
 * `pending_payment` and `past_due` are not frozen (04 §1 freezes `active`): a pending one cannot be paid at a venue
 * that is not listed, a past-due one keeps its grace.
 */
export const subscriptionLifecycleEffects: SubscriptionLifecycleHook = {
  async onOperatorStatusChanged(tx, { orgId, from, to, requestId }) {
    const actor: SubActor = { type: 'system', name: `operator.${to}`, requestId };
    if (to === 'terminated') {
      for (const sub of await lockLive(tx, { orgId }, [
        'pending_eligibility',
        'pending_payment',
        'active',
        'past_due',
        'frozen',
      ]))
        await terminate(tx, sub, actor);
      return;
    }
    if (blocked(to) && !blocked(from)) {
      for (const sub of await lockLive(tx, { orgId }, ['active']))
        await freeze(tx, sub, 'operator_suspended', actor);
      return;
    }
    if (!blocked(to) && blocked(from)) {
      for (const sub of await lockLive(tx, { orgId }, ['frozen'])) {
        if (sub.frozen_reason !== 'operator_suspended') continue;
        await release(tx, sub, (await venueInactive(tx, sub)) ? 'venue_inactive' : null, actor);
      }
    }
  },

  async onVenueStatusChanged(tx, { orgId, venueId, from, to, requestId }) {
    const actor: SubActor = { type: 'system', name: `venue.${to}`, requestId };
    if (to !== 'active' && from === 'active') {
      for (const sub of await lockLive(tx, { orgId, venueId }, ['active'])) {
        // 04 §7 (DEC-599; annex clause 5): a plan whose closure policy is `continue` keeps counting through a closure
        // outside POINT's control — no freeze, no extension, the subscriber told; the freeze right stays theirs
        if ((await policyOf(tx, sub)).closure_policy === 'continue') {
          await push(tx, sub, 'subscription_venue_closure', `venue_inactive:${tx.now.getTime()}`);
          continue;
        }
        await freeze(tx, sub, 'venue_inactive', actor);
      }
      return;
    }
    if (to === 'active' && from !== 'active') {
      const opBlocked = await operatorBlocked(tx, orgId);
      for (const sub of await lockLive(tx, { orgId, venueId }, ['frozen'])) {
        if (sub.frozen_reason !== 'venue_inactive') continue;
        await release(tx, sub, opBlocked ? 'operator_suspended' : null, actor);
      }
    }
  },

  async onAccountDeleted(tx, { accountId, requestId }) {
    const subs = await lockLive(tx, { orgId: '', accountId }, [
      'pending_eligibility',
      'pending_payment',
      'active',
      'past_due',
      'frozen',
    ]);
    for (const sub of subs)
      await transition(
        tx,
        sub,
        'account_deleted',
        { ...endPatch(tx, sub, 'account_deleted'), cancel_at_period_end: false, cancel_requested_at: null },
        { type: 'customer', accountId, requestId },
      );
    return subs.length;
  },
};

registerSubscriptionLifecycleHook(subscriptionLifecycleEffects);
