/**
 * Wire types used by the web app, from docs/07_openapi.yaml (components.schemas). Kept local until
 * @point/shared publishes the zod wire schemas (05 §3); field names follow the contract exactly.
 */
export type Role = 'owner' | 'admin' | 'supervisor' | 'driver';
export type DriverState =
  'off_duty' | 'on_break' | 'available' | 'intake_parking' | 'retrieving' | 'busy_with_next';
export type ConnectionState = 'online' | 'uncertain' | 'offline';
export type TicketStatus =
  | 'received'
  | 'parking'
  | 'parked'
  | 'requested'
  | 'assigned'
  | 'assigned_waiting'
  | 'retrieving'
  | 'ready'
  | 'delivered'
  | 'reparking'
  | 'voided';
export type DutyStatus = 'on_duty' | 'on_break' | 'ended';
/** auth_sessions.revoked_reason (canon §5.7) as carried by `AUTH_SESSION_REVOKED` / `session.revoked`. */
export type RevokedReason =
  'logout' | 'transfer' | 'disabled' | 'secret_reset' | 'admin' | 'expired' | 'expired_cleanup';

export interface Meta {
  request_id: string;
  server_time: string;
  replayed?: boolean;
  next_cursor?: string | null;
}

export interface Envelope<T> {
  data: T;
  meta: Meta;
}

export interface FieldError {
  field: string;
  issue: string;
  message_ar?: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  message_ar: string;
  request_id: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

export interface User {
  id: string;
  employee_code: string;
  full_name: string;
  phone_e164?: string | null;
  phone_masked?: string;
  role: Role;
  can_drive?: boolean;
  status: 'active' | 'disabled';
  mfa_enabled?: boolean;
  must_change_secret?: boolean;
  last_login_at?: string | null;
  version: number;
}

export interface RoleScope {
  id: string;
  scope_type: 'org' | 'venue';
  venue_id: string | null;
  granted_at?: string;
}

export interface DriverAssignment {
  id: string;
  driver_id: string;
  venue_id: string;
  venue_name_ar?: string;
  status: 'scheduled' | 'active' | 'ended';
  starts_at: string;
  ends_at?: string | null;
}

export interface DutySession {
  id: string;
  user_id: string;
  shift_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  status: DutyStatus;
  started_at: string;
  ended_at?: string | null;
  available_since?: string | null;
  connection_state: ConnectionState;
  version: number;
}

export interface Me {
  user: User;
  permissions: string[];
  scopes: RoleScope[];
  active_assignment?: DriverAssignment | null;
  duty_session?: DutySession | null;
  driver_state?: DriverState | null;
  session: {
    expires_at?: string;
    mfa_verified?: boolean;
    /** true while the session is limited to `auth.self` (secret change and/or MFA setup pending). */
    restricted?: boolean;
  };
  brand: {
    staff_name_ar?: string;
    staff_name_en?: string;
    customer_name_ar?: string;
  };
  heartbeat?: {
    interval_s?: number;
    uncertain_after_s?: number;
    offline_after_s?: number;
  };
}

export interface LoginRequest {
  phone: string;
  secret: string;
  device_label?: string;
}

export interface LoginResult {
  mfa_required: boolean;
  mfa_token?: string | null;
  mfa_setup_required: boolean;
  must_change_secret: boolean;
  me?: Me | null;
}

export interface MfaSetup {
  otpauth_uri: string;
  secret_base32: string;
}
