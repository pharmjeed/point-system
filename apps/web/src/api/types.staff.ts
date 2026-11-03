import type { RoleScope, TicketStatus, User, WaHealthStatus, WaLinkStatus } from './types';

/**
 * Wire shapes of the staff-only routes the supervisor/admin screens added for the go-live gaps (GAP-2, GAP-3,
 * GAP-6; docs/runbooks/go-live-checklist.md §2). Names and fields are those of docs/07_openapi.yaml
 * `components.schemas`; kept apart from ./types.ts so the staff chunk owns them.
 */

/** One row of `GET /v1/staff` (07 §2.6): the account and its live scopes. */
export interface StaffMember {
  user: User;
  scopes: RoleScope[];
}

/** `POST /v1/staff` reply: the temporary password is shown once and never kept (07 §2.6, 09 §9). */
export interface CreatedStaff {
  user: User;
  temporary_secret: string;
}

/** `LinkCodeQr` of 07: the customer-facing QR panel (canon §1 rule 2). */
export interface LinkCodeQr {
  link_code_id: string;
  code: string;
  status: 'active' | 'pending_confirmation' | 'consumed' | 'expired' | 'revoked';
  expires_at: string;
  wa_me_url: string;
  prefilled_text: string;
  qr_text: string;
}

/** `WaLinkResult` of 07 (`POST /v1/tickets/{ticketId}/whatsapp-link`). */
export interface WaLinkResult {
  method: 'direct' | 'qr';
  wa_link_status: WaLinkStatus;
  channel_health: WaHealthStatus;
  qr?: LinkCodeQr | null;
}

/** `DutySession` of 07 (the reply of `POST /v1/duty-sessions/{sessionId}/force-end`). */
export interface ForcedDutySession {
  id: string;
  user_id: string;
  status: 'on_duty' | 'on_break' | 'ended';
  ended_at?: string | null;
  end_reason?: 'self' | 'forced' | 'transfer' | 'disabled' | 'shift_closed' | null;
  version: number;
}

/** `target_status` of `POST /v1/tickets/{ticketId}/manual-reconcile` (canon §5 API values). */
export type ReconcileTarget = Extract<TicketStatus, 'parked' | 'delivered' | 'voided'>;

/** Body of `POST /v1/tickets/{ticketId}/manual-reconcile` (07 `manualReconcile`, `PaymentInputAttributed`). */
export interface ManualReconcileBody {
  target_status: ReconcileTarget;
  reason: string;
  evidence: { paper_log_ref: string; note?: string };
  parking_spot_id?: string | null;
  spot_note?: string | null;
  key_slot_id?: string | null;
  incident_id?: string | null;
  payment?: {
    method: 'cash' | 'pos';
    amount_halalas: number;
    pos_reference?: string | null;
    collected_by: string;
  } | null;
  expected_version?: number;
}
