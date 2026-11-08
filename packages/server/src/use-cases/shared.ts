import type { ActorContext } from '../core/actor-context/actor-context.js';
import { audit } from '../core/audit/audit-writer.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import type { TaskRow } from '../modules/dispatch/index.js';
import type { EventActor } from '../modules/tickets-custody/index.js';

export const eventActor = (a: ActorContext): EventActor => ({ type: 'user', id: a.userId });

/** One audit row per command (PNT-009): action = permission name (11 §1.1 rule 4), operation in metadata. */
export async function auditCommand(
  tx: Tx,
  actor: ActorContext,
  e: {
    action: string;
    operation: string;
    entityType: string;
    entityId: string;
    venueId?: string | null;
    requestId: string;
    reason?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await audit(tx, {
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId, role: actor.role },
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    venueId: e.venueId ?? null,
    requestId: e.requestId,
    reason: e.reason ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    metadata: { operation: e.operation, ...(e.metadata ?? {}) },
  });
}

/** A task addressed by id: missing or outside the caller's venues → RESOURCE_NOT_FOUND (08 §1.3 rule 4). */
export async function findTaskInScope(tx: Tx, actor: ActorContext, taskId: string): Promise<TaskRow> {
  const t = await tx.maybeOne<TaskRow>(`SELECT * FROM tasks WHERE id = $1 AND org_id = $2`, [
    taskId,
    actor.orgId,
  ]);
  if (!t || !actor.venueIds.has(t.venue_id)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'task' });
  return t;
}

export function assertAssignee(actor: ActorContext, task: Pick<TaskRow, 'id' | 'assignee_id'>): void {
  if (task.assignee_id !== actor.userId) throw new AppError('NOT_TASK_ASSIGNEE', { task_id: task.id });
}

/** The open (not completed/canceled) task of a ticket, read without a lock. */
export async function openTaskIdOf(tx: Tx, ticketId: string): Promise<string | null> {
  const r = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM tasks WHERE ticket_id = $1 AND status NOT IN ('completed','canceled')`,
    [ticketId],
  );
  return r?.id ?? null;
}
