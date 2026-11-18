import { PLATFORM_ALERT_SEVERITY, type PlatformAlertType } from '@point/shared';
import type { Tx } from '../db/tx.js';
import { redact } from '../logging/redact.js';
import { metrics } from '../metrics/metrics.js';

export interface RaisePlatformAlertInput {
  type: PlatformAlertType;
  /** one live alert per key, e.g. `payment_unknown:<gateway payment id>` */
  dedupeKey: string;
  onlinePaymentId?: string | null;
  /** ids, amounts and codes only (no phone, no card, no token) */
  details?: Record<string, unknown>;
}

/**
 * The platform's finance alerts (P-01 / P-08, DEC-514), beside the operators' raiseAlert: the same live-row rule
 * (one alert per dedupe key until it is resolved; a repeat refreshes `details` and counts `occurrences`), on
 * `platform_alerts` because the operators' `alerts` need a venue and reach its supervisors (14 §8), while POINT's
 * money concerns no operator. Written in the caller's transaction; the metric counts the alerts created.
 */
export async function raisePlatformAlert(
  tx: Tx,
  a: RaisePlatformAlertInput,
): Promise<{ id: string; created: boolean }> {
  const r = await tx.one<{ id: string; inserted: boolean }>(
    `INSERT INTO platform_alerts (type, severity, dedupe_key, online_payment_id, details, raised_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (dedupe_key) WHERE status <> 'resolved'
     DO UPDATE SET details = EXCLUDED.details, last_seen_at = EXCLUDED.last_seen_at,
                   occurrences = platform_alerts.occurrences + 1
     RETURNING id, (xmax = 0) AS inserted`,
    [
      a.type,
      PLATFORM_ALERT_SEVERITY[a.type],
      a.dedupeKey,
      a.onlinePaymentId ?? null,
      JSON.stringify(redact(a.details ?? {})),
      tx.now,
    ],
  );
  if (r.inserted) metrics.platformAlerts.inc({ type: a.type });
  return { id: r.id, created: r.inserted };
}

/** Resolves the live alert of a key when its condition is gone (the system resolves it: resolved_by NULL). */
export async function resolvePlatformAlert(tx: Tx, dedupeKey: string, note: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE platform_alerts SET status = 'resolved', resolved_at = $2, resolution_note = $3
      WHERE dedupe_key = $1 AND status <> 'resolved'`,
    [dedupeKey, tx.now, note],
  );
  return (r.rowCount ?? 0) > 0;
}
