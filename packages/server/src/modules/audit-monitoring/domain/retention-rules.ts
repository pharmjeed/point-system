import { orgSettingsSchema, type OrgSettings } from '@point/shared';

/** The `retention` section of `organizations.settings` (canon §12 keys + `approved_by_owner`). */
export const RETENTION_SECTION = orgSettingsSchema.shape.retention;

/**
 * `settings.retention` with the canon §12 defaults, parsed on its own: the other sections (owned by
 * `/v1/admin/org-settings`) are neither read nor required to be valid here.
 */
export function retentionOf(settings: unknown): OrgSettings['retention'] {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  return RETENTION_SECTION.parse(s.retention ?? {});
}

/**
 * Retention cut-offs (06 ERD §8.1). The owner's durations come from `organizations.settings.retention`
 * (canon §12, Q-06); the "technical" durations of 06 §8.1 have no settings key and are constants here.
 */
export const TECHNICAL_RETENTION = {
  /** outbox_events done/canceled */
  outboxDoneDays: 14,
  /** outbox_events failed/dead (after their review) */
  outboxFailedDays: 90,
  /** action_tokens after expires_at or revoked_at */
  actionTokenDays: 30,
  /** link_codes after expires_at */
  linkCodeDays: 7,
  /** auth_sessions after expiry or revocation */
  sessionDays: 30,
  /** resolved alerts */
  alertMonths: 12,
  /** exports rows once the file is gone */
  exportRowDays: 90,
  /** Push keys of devices revoked this long ago are cleared */
  revokedDeviceMonths: 12,
  /**
   * DEC-101: a `media_assets` row still `pending` this long after the upload URL expired becomes `failed`
   * (its `incoming/` object, if any, expires by the bucket lifecycle rule, DEC-97).
   */
  staleUploadMarginS: 3600,
} as const;

const DAY_MS = 86_400_000;

export function minusDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function minusSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() - seconds * 1000);
}

/** Calendar months back in UTC; the day is clamped to the target month (31 March − 1 month = 28/29 Feb). */
export function minusMonths(now: Date, months: number): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

export interface RetentionCutoffs {
  photos: Date;
  waMessages: Date;
  waRaw: Date;
  tickets: Date;
  audit: Date;
  analytics: Date;
  outboxDone: Date;
  outboxFailed: Date;
  actionTokens: Date;
  linkCodes: Date;
  sessions: Date;
  alerts: Date;
  exportRows: Date;
  revokedDevices: Date;
  staleUploads: Date;
}

export function retentionCutoffs(
  now: Date,
  policy: OrgSettings['retention'],
  mediaUploadUrlTtlS: number,
): RetentionCutoffs {
  return {
    photos: minusDays(now, policy.photos_days),
    waMessages: minusDays(now, policy.wa_messages_days),
    waRaw: minusDays(now, policy.wa_raw_days),
    tickets: minusMonths(now, policy.tickets_months),
    audit: minusMonths(now, policy.audit_months),
    analytics: minusMonths(now, policy.analytics_months),
    outboxDone: minusDays(now, TECHNICAL_RETENTION.outboxDoneDays),
    outboxFailed: minusDays(now, TECHNICAL_RETENTION.outboxFailedDays),
    actionTokens: minusDays(now, TECHNICAL_RETENTION.actionTokenDays),
    linkCodes: minusDays(now, TECHNICAL_RETENTION.linkCodeDays),
    sessions: minusDays(now, TECHNICAL_RETENTION.sessionDays),
    alerts: minusMonths(now, TECHNICAL_RETENTION.alertMonths),
    exportRows: minusDays(now, TECHNICAL_RETENTION.exportRowDays),
    revokedDevices: minusMonths(now, TECHNICAL_RETENTION.revokedDeviceMonths),
    staleUploads: minusSeconds(now, mediaUploadUrlTtlS + TECHNICAL_RETENTION.staleUploadMarginS),
  };
}
