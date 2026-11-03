import { describe, expect, it } from 'vitest';
import {
  MESSAGING_LIMIT_KEY_PREFIX,
  SERVICE_QUOTA_KEY_PREFIX,
  WA_SERVICE_MESSAGES_ALERT_AT,
  isQuotaDedupeKey,
  messagingLimit,
  messagingLimitDedupeKey,
  messagingLimitThreshold,
  serviceQuotaDedupeKey,
  waQuotaConditions,
  type WaQuotaSnapshot,
} from '../src/modules/audit-monitoring/domain/wa-quota.js';
import { phoneNumberFacts } from '../src/modules/whatsapp/infra/channel.js';

const CH = '00000000-0000-4000-8000-000e00000001';
const snap = (o: Partial<WaQuotaSnapshot> = {}): WaQuotaSnapshot => ({
  orgId: '00000000-0000-4000-8000-000100000001',
  channelId: CH,
  month: '2026-10',
  serviceMessagesMonth: 0,
  uniqueUsers24hOutsideWindow: 0,
  limitTier: 'TIER_250',
  ...o,
});

/** GAP-9: the 12 §13 thresholds of the WhatsApp quota gauges (F-03, F-18). */
describe('WhatsApp quota rules (12 §13)', () => {
  it('reads every Meta messaging-limit tier; unknown or missing assumes the F-18 starting limit', () => {
    expect(messagingLimit('TIER_50')).toEqual({ limit: 50, source: 'channel' });
    expect(messagingLimit('TIER_250')).toEqual({ limit: 250, source: 'channel' });
    expect(messagingLimit('TIER_1K')).toEqual({ limit: 1000, source: 'channel' });
    expect(messagingLimit('TIER_2K')).toEqual({ limit: 2000, source: 'channel' });
    expect(messagingLimit('TIER_10K')).toEqual({ limit: 10_000, source: 'channel' });
    expect(messagingLimit('TIER_100K')).toEqual({ limit: 100_000, source: 'channel' });
    expect(messagingLimit('tier_2k')).toEqual({ limit: 2000, source: 'channel' });
    expect(messagingLimit('TIER_UNLIMITED')).toEqual({ limit: null, source: 'channel' });
    for (const v of [null, undefined, '', 'TIER_', 'TIER_0', 'GREEN', 'TIER_-5'])
      expect(messagingLimit(v)).toEqual({ limit: 250, source: 'assumed' });
  });

  it('alerts at 80 % of the limit, rounded up; never for an unlimited tier', () => {
    expect(messagingLimitThreshold(250)).toBe(200);
    expect(messagingLimitThreshold(2000)).toBe(1600);
    expect(messagingLimitThreshold(50)).toBe(40);
    expect(messagingLimitThreshold(null)).toBeNull();
  });

  it('service messages: 800 of the 1,000 free ones of the month (F-03)', () => {
    expect(WA_SERVICE_MESSAGES_ALERT_AT).toBe(800);
    expect(waQuotaConditions(snap({ serviceMessagesMonth: 799 }))).toEqual([]);
    expect(waQuotaConditions(snap({ serviceMessagesMonth: 800 }))).toEqual([
      {
        dedupeKey: `wa_send_failed:service_messages_month:${CH}:2026-10`,
        details: {
          quota: 'service_messages_month',
          channel_id: CH,
          month: '2026-10',
          count: 800,
          threshold: 800,
          free_per_month: 1000,
        },
      },
    ]);
  });

  it('unique users outside the window: 80 % of the channel limit (F-18), the assumed one when unknown', () => {
    expect(waQuotaConditions(snap({ uniqueUsers24hOutsideWindow: 199 }))).toEqual([]);
    expect(waQuotaConditions(snap({ uniqueUsers24hOutsideWindow: 200 }))).toEqual([
      {
        dedupeKey: `wa_send_failed:unique_users_24h:${CH}`,
        details: {
          quota: 'unique_users_24h_outside_window',
          channel_id: CH,
          count: 200,
          threshold: 200,
          limit: 250,
          limit_tier: 'TIER_250',
          limit_source: 'channel',
          window_h: 24,
        },
      },
    ]);
    expect(waQuotaConditions(snap({ uniqueUsers24hOutsideWindow: 1599, limitTier: 'TIER_2K' }))).toEqual([]);
    expect(
      waQuotaConditions(snap({ uniqueUsers24hOutsideWindow: 1600, limitTier: 'TIER_2K' }))[0]?.details,
    ).toMatchObject({ threshold: 1600, limit: 2000 });
    expect(
      waQuotaConditions(snap({ uniqueUsers24hOutsideWindow: 10 ** 6, limitTier: 'TIER_UNLIMITED' })),
    ).toEqual([]);
    expect(
      waQuotaConditions(snap({ uniqueUsers24hOutsideWindow: 200, limitTier: null }))[0]?.details,
    ).toMatchObject({ limit: 250, limit_source: 'assumed', limit_tier: null });
  });

  it('both conditions at once; the keys are recognized and never look like a ticket key', () => {
    const c = waQuotaConditions(snap({ serviceMessagesMonth: 900, uniqueUsers24hOutsideWindow: 240 }));
    expect(c.map((x) => x.dedupeKey)).toEqual([
      serviceQuotaDedupeKey(CH, '2026-10'),
      messagingLimitDedupeKey(CH),
    ]);
    for (const k of c.map((x) => x.dedupeKey)) expect(isQuotaDedupeKey(k)).toBe(true);
    expect(isQuotaDedupeKey(`wa_send_failed:${CH}:W-05`)).toBe(false); // the per-message key (14 §8)
    expect(isQuotaDedupeKey(null)).toBe(false);
    expect(SERVICE_QUOTA_KEY_PREFIX.startsWith('wa_send_failed:')).toBe(true);
    expect(MESSAGING_LIMIT_KEY_PREFIX.startsWith('wa_send_failed:')).toBe(true);
    // the details carry ids and counts only (DEC-38: no phone, code or name)
    expect(JSON.stringify(c)).not.toMatch(/\+?9665|phone|name/);
  });

  it('keeps the quality rating and messaging limit of GET /{phone_number_id}, the current field first (12 §3.1)', () => {
    expect(
      phoneNumberFacts({
        quality_rating: 'GREEN',
        whatsapp_business_manager_messaging_limit: 'TIER_2K',
        messaging_limit_tier: 'TIER_1K',
      }),
    ).toEqual({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_2K' });
    expect(phoneNumberFacts({ messaging_limit_tier: 'TIER_1K' })).toEqual({
      quality_rating: null,
      messaging_limit_tier: 'TIER_1K',
    });
    expect(phoneNumberFacts({ quality_rating: '<script>', messaging_limit_tier: 'x'.repeat(40) })).toEqual({
      quality_rating: null,
      messaging_limit_tier: null,
    });
    expect(phoneNumberFacts(null)).toEqual({ quality_rating: null, messaging_limit_tier: null });
  });
});
