import { ORG_SETTINGS_DEFAULTS } from '@point/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors/app-error.js';
import { deleterForStore } from '../src/core/hooks/media-objects.js';
import { maskPhone } from '../src/core/logging/redact.js';
import { CursorCodec, isIdCursor } from '../src/modules/audit-monitoring/application/cursor.js';
import { SlidingWindowLimiter } from '../src/modules/audit-monitoring/application/rate-limiter.js';
import {
  isOutboxLagging,
  lagResolvable,
  maskPhonesInText,
  outboxLagThresholdS,
} from '../src/modules/audit-monitoring/domain/monitor-rules.js';
import {
  TECHNICAL_RETENTION,
  minusMonths,
  retentionCutoffs,
  retentionOf,
} from '../src/modules/audit-monitoring/domain/retention-rules.js';
import {
  nextCronRun,
  parseDailyCron,
  retentionDedupeKey,
} from '../src/modules/audit-monitoring/domain/schedule.js';

describe('retention schedule (RETENTION_PURGE_CRON_UTC)', () => {
  it('parses the daily default and plans 02:00 UTC (05:00 Asia/Riyadh)', () => {
    expect(parseDailyCron('0 2 * * *')).toEqual({ minutes: [0], hours: [2] });
    expect(nextCronRun('0 2 * * *', new Date('2026-10-27T16:00:00Z')).toISOString()).toBe(
      '2026-10-28T02:00:00.000Z',
    );
    expect(nextCronRun('0 2 * * *', new Date('2026-10-28T01:59:59Z')).toISOString()).toBe(
      '2026-10-28T02:00:00.000Z',
    );
    // strictly after: a run at 02:00 plans the next day
    expect(nextCronRun('0 2 * * *', new Date('2026-10-28T02:00:00Z')).toISOString()).toBe(
      '2026-10-29T02:00:00.000Z',
    );
    expect(retentionDedupeKey(new Date('2026-10-29T02:00:00Z'))).toBe('retention:2026-10-29');
  });

  it('accepts lists, ranges and steps in minute and hour; refuses non-daily expressions', () => {
    expect(parseDailyCron('*/30 1-3 * * *')).toEqual({ minutes: [0, 30], hours: [1, 2, 3] });
    expect(parseDailyCron('15,45 4 * * *').minutes).toEqual([15, 45]);
    expect(nextCronRun('30 23 * * *', new Date('2026-12-31T23:45:00Z')).toISOString()).toBe(
      '2027-01-01T23:30:00.000Z',
    );
    for (const bad of [
      '0 2 * * 1',
      '0 2 1 * *',
      '61 2 * * *',
      '0 24 * * *',
      '0 2 * *',
      'x 2 * * *',
      '5-1 2 * * *',
    ])
      expect(() => parseDailyCron(bad), bad).toThrow();
  });
});

describe('retention cut-offs (06 ERD §8.1)', () => {
  const now = new Date('2026-03-31T10:00:00.000Z');
  it('subtracts calendar months with the day clamped to the target month', () => {
    expect(minusMonths(now, 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(minusMonths(new Date('2028-03-31T00:00:00Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(minusMonths(now, 12).toISOString()).toBe('2025-03-31T10:00:00.000Z');
    expect(minusMonths(now, 36).toISOString()).toBe('2023-03-31T10:00:00.000Z');
  });

  it('reads settings.retention on its own, with the canon §12 defaults', () => {
    expect(retentionOf(null)).toEqual(ORG_SETTINGS_DEFAULTS.retention);
    // another section that would not parse is not read at all
    expect(retentionOf({ heartbeat: { interval_s: 'x' }, retention: { photos_days: 30 } })).toEqual({
      ...ORG_SETTINGS_DEFAULTS.retention,
      photos_days: 30,
    });
    expect(() => retentionOf({ retention: { photos_days: 0 } })).toThrow();
  });

  it('derives every cut-off from the policy, the technical durations and the upload URL lifetime', () => {
    const c = retentionCutoffs(now, ORG_SETTINGS_DEFAULTS.retention, 300);
    expect(c.photos.toISOString()).toBe('2025-12-31T10:00:00.000Z'); // 90 days
    expect(c.waRaw.toISOString()).toBe('2026-03-24T10:00:00.000Z'); // 7 days
    expect(c.analytics.toISOString()).toBe('2024-03-31T10:00:00.000Z'); // 24 months
    expect(c.outboxDone.getTime()).toBe(now.getTime() - TECHNICAL_RETENTION.outboxDoneDays * 86_400_000);
    // DEC-101: TTL + safety margin
    expect(c.staleUploads.getTime()).toBe(
      now.getTime() - (300 + TECHNICAL_RETENTION.staleUploadMarginS) * 1000,
    );
  });
});

describe('monitor rules (14 §8)', () => {
  it('lags beyond the threshold or with any dead row', () => {
    expect(isOutboxLagging({ oldestDueAgeS: 31, dueCount: 1, deadCount: 0 }, 30)).toBe(true);
    expect(isOutboxLagging({ oldestDueAgeS: 30, dueCount: 1, deadCount: 0 }, 30)).toBe(false);
    expect(isOutboxLagging({ oldestDueAgeS: 0, dueCount: 0, deadCount: 1 }, 30)).toBe(true);
  });
  it('reads ops.outbox_lag_alert_s on its own and never fails over settings', () => {
    expect(outboxLagThresholdS(null)).toBe(30);
    expect(outboxLagThresholdS({ ops: { outbox_lag_alert_s: 45 }, security: { pin_length: 4 } })).toBe(45);
    expect(outboxLagThresholdS({ ops: { outbox_lag_alert_s: 'soon' } })).toBe(30);
    expect(outboxLagThresholdS('garbage')).toBe(30);
  });
  it('resolves only after two minutes below the threshold', () => {
    const since = new Date('2026-10-27T16:00:00Z');
    expect(lagResolvable(null, new Date('2026-10-27T17:00:00Z'))).toBe(false);
    expect(lagResolvable(since, new Date('2026-10-27T16:01:59Z'))).toBe(false);
    expect(lagResolvable(since, new Date('2026-10-27T16:02:00Z'))).toBe(true);
  });
  it('masks Saudi mobile numbers in free text', () => {
    expect(maskPhonesInText('called 0551234567 and +966559876543.', maskPhone)).toBe(
      'called 05•••••567 and 05•••••543.',
    );
    expect(maskPhonesInText('ticket 125, order 12345678901', maskPhone)).toBe(
      'ticket 125, order 12345678901',
    );
  });
});

describe('signed cursors (07 §1.7)', () => {
  const codec = new CursorCodec(Buffer.from('cursor-secret-for-tests'.padEnd(32, '.')).toString('base64'));
  it('round-trips and refuses tampering, another route and garbage', () => {
    const c = codec.encode('audit-log', { id: 42 });
    expect(codec.decode('audit-log', c, isIdCursor)).toEqual({ id: 42 });
    const [body, sig] = c.split('.');
    const forged = `${Buffer.from(JSON.stringify({ id: 1 })).toString('base64url')}.${sig}`;
    for (const bad of [forged, `${body}.${'0'.repeat(32)}`, 'garbage', `${body}`, `${c}.x`]) {
      expect(() => codec.decode('audit-log', bad, isIdCursor)).toThrow(AppError);
    }
    expect(() => codec.decode('outbox', c, isIdCursor)).toThrow(/PAGINATION_CURSOR_INVALID/);
    const wrongShape = codec.encode('outbox', { id: -1 });
    expect(() => codec.decode('outbox', wrongShape, isIdCursor)).toThrow(AppError);
  });
});

describe('telemetry rate limiter (15 §9.3)', () => {
  it('allows 120 events per device and minute, then answers the wait', () => {
    const l = new SlidingWindowLimiter(120, 60_000);
    expect(l.consume('d1', 50, 0).ok).toBe(true);
    expect(l.consume('d1', 50, 10_000).ok).toBe(true);
    const third = l.consume('d1', 50, 20_000);
    expect(third).toEqual({ ok: false, retryAfterS: 40 }); // the first 50 leave the window at 60 s
    expect(l.consume('d2', 50, 20_000).ok).toBe(true); // another device
    expect(l.consume('d1', 20, 20_000).ok).toBe(true); // 120 exactly
    expect(l.consume('d1', 50, 60_001).ok).toBe(true);
  });
});

describe('deleterForStore (core seam)', () => {
  it('deletes with bounded concurrency and reports failures without throwing', async () => {
    let inFlight = 0;
    let peak = 0;
    const store = {
      async delete(key: string) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        if (key.endsWith('bad')) throw new Error('storage timeout');
      },
    };
    const keys = Array.from({ length: 20 }, (_, i) => (i === 7 ? 'k7-bad' : `k${i}`));
    const r = await deleterForStore(store, 4)(keys);
    expect(r.deleted).toHaveLength(19);
    expect(r.failed).toEqual([{ key: 'k7-bad', error: 'Error: storage timeout' }]);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
