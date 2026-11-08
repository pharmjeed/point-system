import { AppError } from '../../../core/errors/app-error.js';

/** 11 §1.5 shape of INVALID_STATE_TRANSITION (plus `reason` when a finer cause helps the UI). */
export function invalidTransition(
  entityType: string,
  entity: { id: string; status: string; version?: number | null },
  command: string,
  allowedFrom: readonly string[],
  reason?: string,
): AppError {
  return new AppError('INVALID_STATE_TRANSITION', {
    entity_type: entityType,
    entity_id: entity.id,
    current_status: entity.status,
    current_version: entity.version ?? null,
    command,
    allowed_from: [...allowedFrom],
    ...(reason ? { reason } : {}),
  });
}

/** 08 VERSION_CONFLICT details: entity, id, current_version. */
export function versionConflict(entity: string, row: { id: string; version: number }): AppError {
  return new AppError('VERSION_CONFLICT', { entity, id: row.id, current_version: row.version });
}

export function checkVersion(
  entity: string,
  row: { id: string; version: number },
  expected: number | undefined | null,
): void {
  if (expected != null && expected !== row.version) throw versionConflict(entity, row);
}
