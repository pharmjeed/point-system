import type { ErrorCode } from '@point/shared';
import { AppError } from './app-error.js';

/**
 * PostgreSQL constraint → canon code (08 §5). Constraints whose meaning is "no error" (upserts, idempotent
 * inserts) must be handled where they occur with ON CONFLICT; if one still surfaces here it becomes
 * INTERNAL_ERROR and is logged with the constraint name, exactly like an unknown constraint.
 */
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
}

type Rule =
  ErrorCode | ((ctx: PgMapContext) => ErrorCode) | { code: ErrorCode; details: Record<string, unknown> };

export interface PgMapContext {
  /** 'POST /v1/tickets/{ticketId}/retrievals' style operation of the current command, when known. */
  operation?: string;
}

const UNIQUE_RULES: Record<string, Rule> = {
  // 08 §5.1
  uq_dispatch_pools_default: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'is_default', issue: 'duplicate_default' }] },
  },
  uq_driver_assignments_active: 'ASSIGNMENT_CONFLICT',
  uq_driver_transfers_open: 'TRANSFER_ALREADY_PENDING',
  uq_shifts_open_per_pool: 'SHIFT_ALREADY_OPEN',
  uq_duty_sessions_open: 'DUTY_ALREADY_STARTED',
  uq_tickets_paper_serial: 'PAPER_SERIAL_IN_USE',
  uq_tickets_key_tag_open: 'KEY_TAG_IN_USE',
  uq_spot_alloc_spot_active: 'PARKING_SPOT_OCCUPIED',
  uq_spot_alloc_ticket_active: 'INVALID_STATE_TRANSITION',
  uq_key_alloc_slot_active: 'KEY_SLOT_OCCUPIED',
  uq_key_alloc_ticket_active: 'INVALID_STATE_TRANSITION',
  uq_retrieval_cycles_open: 'RETRIEVAL_ALREADY_ACTIVE',
  uq_tasks_open_per_ticket: (ctx) =>
    ctx.operation && /retrievals|retrieval|requestRetrieval/i.test(ctx.operation)
      ? 'RETRIEVAL_ALREADY_ACTIVE'
      : 'INVALID_STATE_TRANSITION',
  uq_tasks_active_movement_driver: 'MOVEMENT_IN_PROGRESS',
  uq_tasks_next_per_driver: 'NEXT_TASK_ALREADY_RESERVED',
  uq_whatsapp_channel_active: {
    code: 'INVALID_STATE_TRANSITION',
    details: { reason: 'channel_already_active' },
  },
  uq_link_codes_live_ticket: 'VERSION_CONFLICT',
  uq_claim_codes_live: 'VERSION_CONFLICT',
  uq_payments_ticket_recorded: 'PAYMENT_ALREADY_RECORDED',
  // 08 §5.2
  users_org_id_employee_code_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'employee_code', issue: 'duplicate' }] },
  },
  users_org_id_phone_e164_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'phone', issue: 'duplicate' }] },
  },
  venues_org_id_code_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'code', issue: 'duplicate' }] },
  },
  dispatch_pools_venue_id_name_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'name', issue: 'duplicate' }] },
  },
  parking_zones_venue_id_name_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'name', issue: 'duplicate' }] },
  },
  parking_spots_zone_id_label_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'label', issue: 'duplicate' }] },
  },
  key_boards_venue_id_name_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'name', issue: 'duplicate' }] },
  },
  key_slots_key_board_id_label_key: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'label', issue: 'duplicate' }] },
  },
};

const CHECK_RULES: Record<string, Rule> = {
  // 08 §5.3
  users_phone_e164_check: 'PHONE_INVALID',
  customers_phone_e164_check: 'PHONE_INVALID',
  tickets_plate_digits_check: 'PLATE_INVALID',
  venues_code_check: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'code', issue: 'invalid' }] },
  },
  ck_events_fee_zero_unless_per_vehicle: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'fee_halalas', issue: 'pricing' }] },
  },
  ck_events_per_vehicle_fee_positive: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'fee_halalas', issue: 'pricing' }] },
  },
  events_fee_halalas_check: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'fee_halalas', issue: 'pricing' }] },
  },
  ck_events_payment_methods: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'allowed_payment_methods', issue: 'pricing' }] },
  },
  ck_payments_no_pan: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'pos_reference', issue: 'card_number_not_allowed' }] },
  },
  payments_amount_halalas_check: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'amount_halalas', issue: 'invalid' }] },
  },
  ck_cycles_staff_requester: 'REASON_REQUIRED',
  ck_tickets_voided_fields: 'REASON_REQUIRED',
  ck_tickets_waiver_fields: 'REASON_REQUIRED',
  ck_payments_reversal_fields: 'REASON_REQUIRED',
  ck_cash_handover_distinct_people: { code: 'PERMISSION_DENIED', details: { reason: 'self_handover' } },
  ck_transfers_distinct_venues: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'to_venue_id', issue: 'same_venue' }] },
  },
  ck_users_can_drive_supervisor_only: {
    code: 'VALIDATION_FAILED',
    details: { fields: [{ field: 'can_drive', issue: 'supervisor_only' }] },
  },
};

function apply(rule: Rule, ctx: PgMapContext, constraint: string): AppError {
  if (typeof rule === 'string') return new AppError(rule, {});
  if (typeof rule === 'function') return new AppError(rule(ctx), {});
  return new AppError(rule.code, { ...rule.details }, { cause: constraint });
}

export interface MappedPgError {
  error: AppError;
  /** true when the code path allowed a state the schema forbids (logged as error with the constraint name). */
  unexpected: boolean;
  /** retry the whole transaction (40001 / 40P01). */
  retryTx?: boolean;
  lockTimeout?: boolean;
}

export function isPgError(e: unknown): e is PgErrorLike & Error {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as PgErrorLike).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((e as PgErrorLike).code!)
  );
}

export function mapPgError(e: PgErrorLike, ctx: PgMapContext = {}): MappedPgError {
  const constraint = e.constraint ?? '';
  switch (e.code) {
    case '23505': {
      const rule = UNIQUE_RULES[constraint];
      return rule ? { error: apply(rule, ctx, constraint), unexpected: false } : internal(constraint);
    }
    case '23514': {
      const rule = CHECK_RULES[constraint];
      return rule ? { error: apply(rule, ctx, constraint), unexpected: false } : internal(constraint);
    }
    case '23503': {
      const m = /is not present in table "([a-z_]+)"/.exec(e.detail ?? '');
      return {
        error: new AppError('RESOURCE_NOT_FOUND', { resource: m?.[1] ?? 'unknown' }),
        unexpected: false,
      };
    }
    case '23502':
      return internal(constraint || 'not_null');
    case '40001':
    case '40P01':
      return {
        error: new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 1 }),
        unexpected: false,
        retryTx: true,
      };
    case '55P03':
      return {
        error: new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 1 }),
        unexpected: false,
        lockTimeout: true,
      };
    case '57014':
      return { error: new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 1 }), unexpected: false };
    case '55000':
      // «database … is not currently accepting connections» (maintenance, a restore switch-over)
      if (isDbUnavailableError(e))
        return { error: new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 2 }), unexpected: false };
      return internal(constraint || e.code);
    default:
      if (e.code?.startsWith('08') || e.code?.startsWith('53') || e.code?.startsWith('57P')) {
        return { error: new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 2 }), unexpected: false };
      }
      return internal(constraint || e.code || 'unknown');
  }
}

function internal(constraint: string): MappedPgError {
  return { error: new AppError('INTERNAL_ERROR', {}, { cause: constraint }), unexpected: true };
}

/** Socket errors of a database connection that could not be opened or was cut. */
const CONNECTION_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
/** node-postgres / pg-pool messages for a connection lost mid-query or never obtained. */
const CONNECTION_MESSAGES = [
  /connection terminated/i,
  /connection ended unexpectedly/i,
  /is not queryable/i,
  /timeout exceeded when trying to connect/i,
  /not currently accepting connections/i,
];

/**
 * A database that cannot be reached right now (stopped or restarting server, failover, terminated backends, a
 * network cut). 08 §5 maps SQLSTATE class 08 (connection) to SERVICE_UNAVAILABLE; when the server is gone the
 * driver reports the same situation without any SQLSTATE — a socket error, «Connection terminated unexpectedly»,
 * a pool connect timeout — or as 55000 «not currently accepting connections». All of them answer
 * SERVICE_UNAVAILABLE (retryable, Retry-After) instead of INTERNAL_ERROR (17 §12: database outage).
 */
export function isDbUnavailableError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; message?: unknown; errors?: unknown };
  if (typeof err.code === 'string' && CONNECTION_ERRNO.has(err.code)) return true;
  // the server's own words: class 08 connection exception, 53 resources, 57P0x shutdown / terminated backend
  if (typeof err.code === 'string' && /^(08[0-9A-Z]{3}|53[0-9A-Z]{3}|57P0[0-9])$/.test(err.code)) return true;
  const message = typeof err.message === 'string' ? err.message : '';
  if (CONNECTION_MESSAGES.some((r) => r.test(message))) return true;
  // dual-stack connect attempts fail as one AggregateError (ECONNREFUSED on ::1 and on 127.0.0.1)
  if (Array.isArray(err.errors) && err.errors.length > 0) return err.errors.every(isDbUnavailableError);
  return false;
}

/** The SERVICE_UNAVAILABLE answer for isDbUnavailableError (null otherwise). */
export function dbUnavailableError(e: unknown): AppError | null {
  return isDbUnavailableError(e) ? new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 2 }) : null;
}

export const PG_CONSTRAINT_RULES = { unique: Object.keys(UNIQUE_RULES), check: Object.keys(CHECK_RULES) };
