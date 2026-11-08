import { AppError } from '../../../core/errors/app-error.js';

/**
 * Canon error builders shared by the venues-events commands. Detail shapes:
 * - RESOURCE_NOT_FOUND → `{ resource }` (08 §4.3: the type name only)
 * - VERSION_CONFLICT → `{ entity, id, current_version }` (07 §1.5, 08 §4.4)
 * - INVALID_STATE_TRANSITION → the 11 §1.5 shape (`entity_type`, `entity_id`, `current_status`,
 *   `current_version`, `command`, `allowed_from`) plus `reason` when a guard other than the status fails.
 */

/** Resource names used in `details.resource`. */
export type VenuesResource =
  'venue' | 'dispatch_pool' | 'parking_zone' | 'parking_spot' | 'key_board' | 'key_slot' | 'event' | 'shift';

export function notFound(resource: VenuesResource): AppError {
  return new AppError('RESOURCE_NOT_FOUND', { resource });
}

export function versionConflict(entity: string, id: string, currentVersion: number): AppError {
  return new AppError('VERSION_CONFLICT', { entity, id, current_version: currentVersion });
}

export interface TransitionErrorArgs {
  entityType: 'event' | 'shift' | 'dispatch_pool' | 'parking_spot' | 'key_slot';
  entityId: string;
  currentStatus: string;
  currentVersion?: number | null;
  command: string;
  allowedFrom: readonly string[];
  reason?: string;
}

export function invalidTransition(a: TransitionErrorArgs): AppError {
  return new AppError('INVALID_STATE_TRANSITION', {
    entity_type: a.entityType,
    entity_id: a.entityId,
    current_status: a.currentStatus,
    ...(a.currentVersion != null ? { current_version: a.currentVersion } : {}),
    command: a.command,
    allowed_from: [...a.allowedFrom],
    ...(a.reason ? { reason: a.reason } : {}),
  });
}

/** `expected_version` given and different from the row → VERSION_CONFLICT (11 §1.2 step 6). */
export function assertVersion(
  entity: string,
  row: { id: string; version: number },
  expected: number | undefined,
): void {
  if (expected !== undefined && expected !== row.version) throw versionConflict(entity, row.id, row.version);
}

/** One `details.fields` entry of VALIDATION_FAILED (`FieldError` in 07; extra keys are allowed). */
export interface FieldIssue {
  field: string;
  issue: string;
  message_ar?: string;
  [extra: string]: unknown;
}

export function validationFailed(fields: FieldIssue[]): AppError {
  return new AppError('VALIDATION_FAILED', { fields });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path ids are checked before any query so a malformed id is simply "not found" (never a 500). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
