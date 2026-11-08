import { OUTBOX_STATUSES } from '@point/shared';
import { z } from 'zod';

const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
};
const name = (max = 64) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[a-z][a-z0-9_.]*$/);

/** `GET /v1/admin/audit-log` query (07_openapi `listAuditLog`). */
export const AuditLogQuery = z.strictObject({
  entity_type: name().optional(),
  entity_id: z.uuid().optional(),
  actor_id: z.string().min(1).max(64).optional(),
  action: name().optional(),
  venue_id: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  ...page,
});
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;

/** `status` may repeat (`?status=dead&status=failed`, OpenAPI array) or be comma separated. */
const statusList = z.preprocess(
  (v) =>
    v === undefined
      ? undefined
      : (Array.isArray(v) ? v : [v])
          .flatMap((s) => String(s).split(','))
          .map((s) => s.trim())
          .filter(Boolean),
  z.array(z.enum(OUTBOX_STATUSES)).min(1).max(OUTBOX_STATUSES.length).optional(),
);

/** `GET /v1/admin/outbox` query (07_openapi `listOutbox`). */
export const OutboxQuery = z.strictObject({
  status: statusList,
  type: name().optional(),
  older_than_s: z.coerce.number().int().min(0).max(315_360_000).optional(),
  ...page,
});
export type OutboxQuery = z.infer<typeof OutboxQuery>;
