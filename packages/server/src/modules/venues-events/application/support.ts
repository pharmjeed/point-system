import type { Permission } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Tx } from '../../../core/db/tx.js';

/** Per-request facts a command needs for its audit row (09 §11) and error details. */
export interface CommandMeta {
  /** canon §9 route key, e.g. `POST /v1/events/{eventId}/open` (= `@Command` operation) */
  operation: string;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditInput {
  /** canon §10 permission used by the command (11 §1.1 rule 4) */
  action: Extract<Permission, 'venue.manage' | 'event.manage' | 'shift.manage'>;
  entityType: string;
  entityId: string;
  venueId: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/** Exactly one audit row per command (PNT-009); `metadata.command` names the route. */
export function auditCommand(tx: Tx, actor: ActorContext, meta: CommandMeta, e: AuditInput): Promise<void> {
  return audit(tx, {
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId, role: actor.role },
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    venueId: e.venueId,
    requestId: meta.requestId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    reason: e.reason ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    metadata: { command: meta.operation, ...(e.metadata ?? {}) },
  });
}

/**
 * `SET col = $n` fragments for the fields present in `patch` (undefined = not sent; null = cleared).
 * Returns the fragments, their parameters (numbered from `firstParam`) and the before/after diff.
 */
export function patchSet(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  columns: readonly string[],
  firstParam: number,
): { sets: string[]; params: unknown[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const sets: string[] = [];
  const params: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const col of columns) {
    const value = patch[col];
    if (value === undefined) continue;
    if (same(current[col], value)) continue;
    params.push(value);
    sets.push(`${col} = $${firstParam + params.length - 1}`);
    before[col] = current[col] instanceof Date ? (current[col] as Date).toISOString() : current[col];
    after[col] = value;
  }
  return { sets, params, before, after };
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && typeof b === 'string') return a.getTime() === new Date(b).getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}
