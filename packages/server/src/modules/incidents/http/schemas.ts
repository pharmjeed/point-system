import {
  AlertSeveritySchema,
  AlertStatusSchema,
  AlertTypeSchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
  IncidentTypeSchema,
} from '@point/shared';
import { z } from 'zod';

/**
 * Request schemas of canon §9.7 alerts and incidents (shapes from 07_openapi.yaml). Bodies are strict (unknown
 * fields → VALIDATION_FAILED); query strings ignore unknown parameters. An array parameter is accepted repeated
 * (`status=open&status=acknowledged`) or comma separated (`status=open,acknowledged`).
 */

const id = () => z.guid();
const limit = z.coerce.number().int().min(1).max(200).default(50);
const cursor = z.string().min(1).max(2048).optional();

const many = <T extends z.ZodType>(item: T) =>
  z
    .preprocess(
      (v) =>
        v === undefined
          ? undefined
          : (Array.isArray(v) ? v : [v]).flatMap((x) =>
              typeof x === 'string'
                ? x
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : [x],
            ),
      z.array(item),
    )
    .optional();

export const ListAlertsQuery = z.object({
  venue_id: id().optional(),
  status: many(AlertStatusSchema),
  type: AlertTypeSchema.optional(),
  severity: AlertSeveritySchema.optional(),
  limit,
  cursor,
});
export type ListAlertsQuery = z.output<typeof ListAlertsQuery>;

export const AlertNoteBody = z.strictObject({ note: z.string().max(300).nullable().optional() });
export type AlertNoteBody = z.output<typeof AlertNoteBody>;

export const ListIncidentsQuery = z.object({
  venue_id: id().optional(),
  event_id: id().optional(),
  ticket_id: id().optional(),
  status: many(IncidentStatusSchema),
  type: IncidentTypeSchema.optional(),
  limit,
  cursor,
});
export type ListIncidentsQuery = z.output<typeof ListIncidentsQuery>;

export const CreateIncidentBody = z.strictObject({
  venue_id: id(),
  event_id: id().nullable().optional(),
  ticket_id: id().nullable().optional(),
  type: IncidentTypeSchema,
  severity: IncidentSeveritySchema.optional(),
  description: z.string().trim().min(3).max(2000),
});
export type CreateIncidentBody = z.output<typeof CreateIncidentBody>;

export const UpdateIncidentBody = z.strictObject({
  expected_version: z.number().int().min(1),
  status: IncidentStatusSchema.optional(),
  severity: IncidentSeveritySchema.optional(),
  owner_id: id().nullable().optional(),
  resolution: z.string().max(2000).nullable().optional(),
  description: z.string().trim().min(3).max(2000).optional(),
});
export type UpdateIncidentBody = z.output<typeof UpdateIncidentBody>;
