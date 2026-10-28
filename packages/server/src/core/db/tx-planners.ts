import type { EventEnvelope, Tx } from './tx.js';

/**
 * Planners run inside the producing transaction, right before COMMIT, over the domain events the transaction
 * emitted (DEC-41: NotificationPlanner → notifications + job.wa_send / job.push_send; DEC-48: realtime
 * publishing with pg_notify). They are pure with respect to the network: they only write rows.
 * Modules register their planner once at startup (api and worker); domain code just emits events.
 */
export interface TxPlanner {
  name: string;
  plan(tx: Tx, events: readonly EventEnvelope[]): Promise<void>;
}

const planners: TxPlanner[] = [];

export function registerTxPlanner(p: TxPlanner): void {
  if (planners.some((x) => x.name === p.name)) return;
  planners.push(p);
}

export function unregisterTxPlanner(name: string): void {
  const i = planners.findIndex((x) => x.name === name);
  if (i >= 0) planners.splice(i, 1);
}

export function registeredTxPlanners(): readonly TxPlanner[] {
  return planners;
}

/** Called by Database.transaction before COMMIT. Events emitted by a planner are planned in the next round. */
export async function runTxPlanners(tx: Tx): Promise<void> {
  let from = 0;
  for (let round = 0; round < 5 && from < tx.events.length; round++) {
    const batch = tx.events.slice(from);
    from = tx.events.length;
    for (const p of planners) await p.plan(tx, batch);
  }
}
