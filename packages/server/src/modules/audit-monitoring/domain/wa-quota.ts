/**
 * WhatsApp quota rules of the SystemMonitor (GAP-9; 12 §13 with F-03 and F-18; 05 §12.2).
 *
 * - `point_wa_service_messages_month`: service messages — session texts (W-09 … W-12, and W-05 when it falls back
 *   to a session text, 12 §8.4) — the provider accepted on the organization's number in the current calendar
 *   month. They are free up to 1,000 a month per business number and are not delivered beyond that without a
 *   payment method (F-03); 12 §13 alerts at 800.
 * - `point_wa_unique_users_24h_outside_window`: distinct customers sent a template in the rolling 24 h while
 *   outside the customer service window — no inbound message from them in the 24 h before the send (F-04, F-18).
 *   The messaging limit caps them per business portfolio; 12 §13 alerts at 80 % of the current limit of the
 *   channel (`whatsapp_channel.messaging_limit_tier`).
 *
 * The canon has no alert type for a quota (canon §5.7, 14 §8): the alerts are raised as `wa_send_failed` — what an
 * exhausted quota causes — under their own dedupe keys (docs/progress/notes/server-gaps.md, DEC-PROPOSED-1).
 */

/** F-03: service messages free per business number and month. */
export const WA_SERVICE_MESSAGES_FREE_PER_MONTH = 1000;
/** 12 §13: «800 من 1,000». */
export const WA_SERVICE_MESSAGES_ALERT_AT = 800;
/** 12 §13: «80% من حد المراسلة الحالي». */
export const WA_MESSAGING_LIMIT_ALERT_RATIO = 0.8;
/** F-18: the messaging limit of a new business portfolio, assumed while the channel has none stored. */
export const WA_MESSAGING_LIMIT_DEFAULT = 250;
/** F-04: the customer service window. */
export const WA_SERVICE_WINDOW_HOURS = 24;
/**
 * The calendar month of the free tier. Meta counts it in the WhatsApp Business Account's time zone (secondary
 * sources; re-verify at implementation), which for the customer channel's account is Saudi time.
 */
export const WA_QUOTA_MONTH_TIME_ZONE = 'Asia/Riyadh';
/**
 * The counts move slowly: each process counts them at most once a minute — for its gauges, and for the alert
 * decisions, which are always taken on a count made in the deciding transaction.
 */
export const WA_QUOTA_REFRESH_MS = 60_000;
/**
 * A live quota alert resolves once its condition has stayed false this long (as `outbox_lag`, 14 §8). The instant it
 * turned false is kept in the row (`details.below_since`), so every process continues the same window, and two
 * processes whose clocks differ by less than this never undo each other's decision (a count near the threshold, the
 * month change at midnight in Riyadh).
 */
export const WA_QUOTA_RESOLVE_AFTER_MS = 2 * 60_000;
/** A manual resolution of the messaging-limit alert keeps it quiet for its window (24 h). */
export const WA_MESSAGING_LIMIT_SILENCE_MS = WA_SERVICE_WINDOW_HOURS * 3_600_000;

export const SERVICE_QUOTA_KEY_PREFIX = 'wa_send_failed:service_messages_month:';
export const MESSAGING_LIMIT_KEY_PREFIX = 'wa_send_failed:unique_users_24h:';

/** One key per channel and month: the condition only grows within a month and ends when the month changes. */
export const serviceQuotaDedupeKey = (channelId: string, month: string) =>
  `${SERVICE_QUOTA_KEY_PREFIX}${channelId}:${month}`;
export const messagingLimitDedupeKey = (channelId: string) => `${MESSAGING_LIMIT_KEY_PREFIX}${channelId}`;

export function isQuotaDedupeKey(key: string | null | undefined): boolean {
  return !!key && (key.startsWith(SERVICE_QUOTA_KEY_PREFIX) || key.startsWith(MESSAGING_LIMIT_KEY_PREFIX));
}

export interface MessagingLimit {
  /** unique users per rolling 24 h; null = unlimited */
  limit: number | null;
  /** `channel` when read from the stored tier, `assumed` when the channel has none (F-18 starting limit) */
  source: 'channel' | 'assumed';
}

/**
 * Meta's messaging-limit tiers — `whatsapp_business_manager_messaging_limit`, the legacy `messaging_limit_tier` and
 * the `current_limit` of `phone_number_quality_update` (F-18): `TIER_250`, `TIER_2K`, `TIER_10K`, `TIER_100K`,
 * `TIER_UNLIMITED`, and the legacy `TIER_50`, `TIER_1K`. Anything else (or nothing stored) assumes the F-18 starting
 * limit, so the alert errs on the early side.
 */
export function messagingLimit(tier: string | null | undefined): MessagingLimit {
  const v = (tier ?? '').trim().toUpperCase();
  if (v === 'TIER_UNLIMITED' || v === 'UNLIMITED') return { limit: null, source: 'channel' };
  const m = /^(?:TIER_)?([1-9][0-9]{0,8})(K)?$/.exec(v);
  if (m) return { limit: Number(m[1]) * (m[2] ? 1000 : 1), source: 'channel' };
  return { limit: WA_MESSAGING_LIMIT_DEFAULT, source: 'assumed' };
}

/** 80 % of the limit, rounded up (250 → 200, 2,000 → 1,600); null for an unlimited tier. */
export function messagingLimitThreshold(limit: number | null): number | null {
  return limit === null ? null : Math.ceil(limit * WA_MESSAGING_LIMIT_ALERT_RATIO);
}

/** The counts of one organization's active channel at one instant. */
export interface WaQuotaSnapshot {
  orgId: string;
  channelId: string;
  /** `YYYY-MM` of the instant in WA_QUOTA_MONTH_TIME_ZONE */
  month: string;
  serviceMessagesMonth: number;
  uniqueUsers24hOutsideWindow: number;
  /** `whatsapp_channel.messaging_limit_tier` as stored */
  limitTier: string | null;
}

export interface WaQuotaCondition {
  dedupeKey: string;
  details: Record<string, unknown>;
}

/** The 12 §13 alert conditions that hold for a snapshot (ids and counts only in the details). */
export function waQuotaConditions(s: WaQuotaSnapshot): WaQuotaCondition[] {
  const out: WaQuotaCondition[] = [];
  if (s.serviceMessagesMonth >= WA_SERVICE_MESSAGES_ALERT_AT)
    out.push({
      dedupeKey: serviceQuotaDedupeKey(s.channelId, s.month),
      details: {
        quota: 'service_messages_month',
        channel_id: s.channelId,
        month: s.month,
        count: s.serviceMessagesMonth,
        threshold: WA_SERVICE_MESSAGES_ALERT_AT,
        free_per_month: WA_SERVICE_MESSAGES_FREE_PER_MONTH,
      },
    });
  const { limit, source } = messagingLimit(s.limitTier);
  const threshold = messagingLimitThreshold(limit);
  if (threshold !== null && s.uniqueUsers24hOutsideWindow >= threshold)
    out.push({
      dedupeKey: messagingLimitDedupeKey(s.channelId),
      details: {
        quota: 'unique_users_24h_outside_window',
        channel_id: s.channelId,
        count: s.uniqueUsers24hOutsideWindow,
        threshold,
        limit,
        limit_tier: s.limitTier,
        limit_source: source,
        window_h: WA_SERVICE_WINDOW_HOURS,
      },
    });
  return out;
}
