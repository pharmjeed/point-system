import { venueSettingsSchema, type VenueSettings } from '@point/shared';
import type { ZodError } from 'zod';
import type { FieldIssue } from './errors.js';

/**
 * Venue settings (canon §12, DEC-65): nested objects, strict at every level, missing keys completed from the
 * defaults. `PUT /v1/venues/{venueId}/settings` replaces the whole object: what is not sent takes the default,
 * not the previous value («استبدال … ويُكمَّل الناقص بالافتراضي», 07 §2.5).
 */
export type { VenueSettings };

/**
 * zod issues → `details.fields` with full dotted paths. An unknown key becomes one entry per key at its own path
 * (`settings.dispatch.foo`, issue `unrecognized_key`) instead of one entry on its parent (PNT-018 AC2).
 */
export function zodIssuesToFields(error: ZodError, prefix = ''): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const issue of error.issues) {
    const base = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        out.push({ field: base ? `${base}.${key}` : key, issue: 'unrecognized_key', message: issue.message });
      }
      continue;
    }
    out.push({ field: base || '(body)', issue: issue.code, message: issue.message });
  }
  return out;
}

/** Parses settings for a write; returns the completed object or the field issues. */
export function parseSettingsInput(
  raw: unknown,
): { ok: true; settings: VenueSettings } | { ok: false; fields: FieldIssue[] } {
  const r = venueSettingsSchema.safeParse(raw ?? {});
  if (r.success) return { ok: true, settings: r.data };
  return { ok: false, fields: zodIssuesToFields(r.error, 'settings') };
}
