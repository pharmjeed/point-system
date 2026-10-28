import type { DriverState } from '@point/shared';
import type { TicketQueryable } from '../../tickets-custody/index.js';
import { driverStateOf } from '../infra/dispatch-repo.js';
import type { DutyRow } from '../infra/rows.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** DutySession schema (07), same shape as GET /v1/me. */
export function dutySessionView(d: DutyRow) {
  return {
    id: d.id,
    user_id: d.user_id,
    shift_id: d.shift_id,
    venue_id: d.venue_id,
    dispatch_pool_id: d.dispatch_pool_id,
    status: d.status,
    started_at: iso(d.started_at)!,
    ended_at: iso(d.ended_at),
    end_reason: d.end_reason,
    available_since: iso(d.available_since),
    last_heartbeat_at: iso(d.last_heartbeat_at),
    connection_state: d.connection_state,
    version: d.version,
  };
}

/** Canon §5.6 derived state; no open duty session → off_duty. */
export async function currentDriverState(q: TicketQueryable, userId: string): Promise<DriverState> {
  return (await driverStateOf(q, userId))?.driver_state ?? 'off_duty';
}
