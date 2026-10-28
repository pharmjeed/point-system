import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareIdle, idleCandidates, pickCandidate } from '../src/modules/dispatch/domain/driver-state.js';
import type { PoolDriverRow } from '../src/modules/dispatch/infra/rows.js';

const d = (user: string, since: string | null, extra: Partial<PoolDriverRow> = {}): PoolDriverRow => ({
  duty_session_id: `ds-${user}`,
  user_id: user,
  duty_status: 'on_duty',
  driver_state: 'available',
  available_since: since ? new Date(since) : null,
  connection_state: 'online',
  live_single_offer_id: null,
  ...extra,
});

describe('dispatch — longest idle first (10 §2.3, R-1, R-2)', () => {
  it('orders by available_since then user_id', () => {
    const list = [
      d('c', '2026-10-27T16:00:02Z'),
      d('b', '2026-10-27T16:00:01Z'),
      d('a', '2026-10-27T16:00:02Z'),
    ];
    expect(idleCandidates(list, { offlineLast: false }).map((x) => x.user_id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps only available drivers without a live single offer', () => {
    const list = [
      d('a', '2026-10-27T16:00:00Z', { live_single_offer_id: 'o1' }),
      d('b', '2026-10-27T16:00:01Z', { driver_state: 'intake_parking', available_since: null }),
      d('c', '2026-10-27T16:00:02Z', {
        driver_state: 'on_break',
        duty_status: 'on_break',
        available_since: null,
      }),
      d('e', '2026-10-27T16:00:03Z'),
    ];
    expect(idleCandidates(list, { offlineLast: false }).map((x) => x.user_id)).toEqual(['e']);
  });

  it('dispatch.offline_drivers_last puts uncertain/offline connections after online ones', () => {
    const list = [
      d('a', '2026-10-27T16:00:00Z', { connection_state: 'uncertain' }),
      d('b', '2026-10-27T16:00:05Z'),
    ];
    expect(idleCandidates(list, { offlineLast: true }).map((x) => x.user_id)).toEqual(['b', 'a']);
    expect(idleCandidates(list, { offlineLast: false }).map((x) => x.user_id)).toEqual(['a', 'b']);
    expect(compareIdle(list[0]!, list[1]!, false)).toBeLessThan(0);
  });

  it('skips drivers tried in this episode or blocked by an older live round', () => {
    const idle = [
      d('a', '2026-10-27T16:00:00Z'),
      d('b', '2026-10-27T16:00:01Z'),
      d('c', '2026-10-27T16:00:02Z'),
    ];
    expect(pickCandidate(idle, new Set(['a']), new Set())?.user_id).toBe('b');
    expect(pickCandidate(idle, new Set(['a']), new Set(['b']))?.user_id).toBe('c');
    expect(pickCandidate(idle, new Set(['a', 'b', 'c']), new Set())).toBeUndefined();
  });
});

/** 04 §4.3 rule 2: tickets-custody never imports dispatch (nor the use-cases that compose both). */
describe('module boundaries', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  it('tickets-custody imports neither dispatch nor use-cases', () => {
    const root = join(import.meta.dirname, '../src/modules/tickets-custody');
    const offenders = files(root).filter((f) =>
      /from '[^']*(modules\/dispatch|\/dispatch\/|use-cases)[^']*'/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
  it('dispatch does not import the use-cases', () => {
    const root = join(import.meta.dirname, '../src/modules/dispatch');
    const offenders = files(root).filter((f) => /from '[^']*use-cases[^']*'/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
