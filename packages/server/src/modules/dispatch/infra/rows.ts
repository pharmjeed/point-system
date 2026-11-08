import type { DriverState, OfferCloseReason, OfferMode, TaskStatus, TaskType } from '@point/shared';

/** `dispatch_pools` row — the pool lock (L1). */
export interface PoolRow {
  id: string;
  org_id: string;
  venue_id: string;
  name: string;
  is_default: boolean;
  status: 'active' | 'inactive';
  last_pass_at: Date | null;
  pass_count: number;
}

/** `tasks` row. */
export interface TaskRow {
  id: string;
  org_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  event_id: string;
  ticket_id: string;
  cycle_id: string | null;
  type: TaskType;
  status: TaskStatus;
  priority_at: Date;
  seq: number;
  assignee_id: string | null;
  queued_at: Date | null;
  first_offered_at: Date | null;
  broadcast_at: Date | null;
  claimed_at: Date | null;
  assigned_waiting_at: Date | null;
  accepted_at: Date | null;
  key_picked_up_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  canceled_at: Date | null;
  canceled_by: string | null;
  cancel_reason: string | null;
  escalated_at: Date | null;
  version: number;
  created_at: Date;
}

/** `task_offers` row. */
export interface OfferRow {
  id: string;
  org_id: string;
  task_id: string;
  dispatch_pool_id: string;
  mode: OfferMode;
  round_no: number;
  status: 'active' | 'accepted' | 'expired' | 'revoked';
  created_at: Date;
  reminder_at: Date | null;
  reminded_at: Date | null;
  expires_at: Date | null;
  closed_at: Date | null;
  close_reason: OfferCloseReason | null;
  accepted_by: string | null;
  version: number;
}

/** `duty_sessions` row. */
export interface DutyRow {
  id: string;
  org_id: string;
  user_id: string;
  shift_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  assignment_id: string | null;
  status: 'on_duty' | 'on_break' | 'ended';
  started_at: Date;
  ended_at: Date | null;
  ended_by: string | null;
  end_reason: 'self' | 'forced' | 'transfer' | 'disabled' | 'shift_closed' | null;
  available_since: Date | null;
  last_heartbeat_at: Date | null;
  connection_state: 'online' | 'uncertain' | 'offline';
  version: number;
}

/** A row of the open demand of a pool (10 §4.2 query 2). */
export interface QueueTask {
  id: string;
  status: 'queued' | 'offered' | 'broadcast';
  priority_at: Date;
  seq: number;
  queued_at: Date | null;
  ticket_id: string;
  cycle_id: string | null;
  version: number;
  live_offer_id: string | null;
  live_offer_mode: OfferMode | null;
  expires_at: Date | null;
}

/** A pool driver with its derived state (10 §4.2 query 3). */
export interface PoolDriverRow {
  duty_session_id: string;
  user_id: string;
  duty_status: 'on_duty' | 'on_break';
  driver_state: DriverState;
  available_since: Date | null;
  connection_state: 'online' | 'uncertain' | 'offline';
  live_single_offer_id: string | null;
}
