import { describe, expect, it, vi } from 'vitest';
import type { Alert } from '@/api/types';
import { AlertSoundController, type Scheduler, type SoundPlayer } from '@/features/supervisor/alertSound';
import { alert } from './fixtures';

/** Manual clock for the repeat timer. */
function fakeScheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = until;
  };
  return { scheduler, advance, pending: () => timers.size };
}

function fakePlayer(result = true) {
  const player = { plays: 0, stops: 0, result } as {
    plays: number;
    stops: number;
    result: boolean;
  } & SoundPlayer;
  player.play = vi.fn(async () => {
    player.plays += 1;
    return player.result;
  });
  player.stop = vi.fn(() => {
    player.stops += 1;
  });
  return player;
}

function setup(opts: { blocked?: boolean } = {}) {
  const clock = fakeScheduler();
  const escalation = fakePlayer(!opts.blocked);
  const reminder = fakePlayer();
  const onBlocked = vi.fn();
  const controller = new AlertSoundController({
    escalation,
    reminder,
    scheduler: clock.scheduler,
    repeatMs: 60_000,
    maxRepeats: 3,
    onBlocked,
  });
  return { controller, escalation, reminder, clock, onBlocked };
}

const critical = (over: Partial<Alert> = {}) => alert({ id: 'c-1', severity: 'critical', ...over });
const warning = (over: Partial<Alert> = {}) =>
  alert({ id: 'w-1', type: 'next_task_waiting_long', severity: 'warning', ...over });

describe('supervisor alert sound (14 §7, §10)', () => {
  it('stays silent until the user unlocked audio', () => {
    const { controller, escalation, clock } = setup();
    controller.sync([critical()]);
    clock.advance(10 * 60_000);
    expect(escalation.plays).toBe(0);
    controller.enable();
    expect(escalation.plays).toBe(1);
  });

  it('repeats a critical alert every 60 s, at most 3 times after the first play', () => {
    const { controller, escalation, clock } = setup();
    controller.enable();
    controller.sync([critical()]);
    expect(escalation.plays).toBe(1);
    clock.advance(59_999);
    expect(escalation.plays).toBe(1);
    clock.advance(1);
    expect(escalation.plays).toBe(2);
    clock.advance(10 * 60_000);
    expect(escalation.plays).toBe(4);
    expect(clock.pending()).toBe(0);
    controller.sync([critical()]); // the same alert on the next refresh does not restart it
    clock.advance(10 * 60_000);
    expect(escalation.plays).toBe(4);
  });

  it('acknowledging stops the sound at once and no repeat follows', () => {
    const { controller, escalation, clock } = setup();
    controller.enable();
    controller.sync([critical()]);
    clock.advance(60_000);
    expect(escalation.plays).toBe(2);
    controller.sync([critical({ status: 'acknowledged' })]);
    expect(escalation.stops).toBe(1);
    expect(controller.escalating).toEqual([]);
    clock.advance(10 * 60_000);
    expect(escalation.plays).toBe(2);
  });

  it('resolving or the alert disappearing also stops it', () => {
    const { controller, escalation, clock } = setup();
    controller.enable();
    controller.sync([critical(), critical({ id: 'c-2' })]);
    expect(controller.escalating).toEqual(['c-1', 'c-2']);
    controller.sync([critical({ id: 'c-2', status: 'resolved' })]);
    expect(controller.escalating).toEqual([]);
    expect(escalation.stops).toBeGreaterThan(0);
    clock.advance(5 * 60_000);
    expect(escalation.plays).toBe(2);
  });

  it('plays the reminder once for a new warning; existing warnings and info alerts are silent', () => {
    const { controller, reminder } = setup();
    controller.enable();
    controller.sync([warning({ id: 'w-old' })]);
    expect(reminder.plays).toBe(0); // already there when the screen opened
    controller.sync([warning({ id: 'w-old' }), warning({ id: 'w-new' })]);
    expect(reminder.plays).toBe(1);
    controller.sync([warning({ id: 'w-old' }), warning({ id: 'w-new' })]);
    controller.sync([warning({ id: 'w-new' }), alert({ id: 'i-1', severity: 'info' })]);
    expect(reminder.plays).toBe(1);
  });

  it('gives the escalation priority over a reminder', () => {
    const { controller, reminder, escalation } = setup();
    controller.enable();
    controller.sync([]);
    controller.sync([critical(), warning()]);
    expect(escalation.plays).toBe(1);
    expect(reminder.plays).toBe(0);
  });

  it('a refused play disables the sound and asks for the unlock again', async () => {
    const { controller, escalation, clock, onBlocked } = setup({ blocked: true });
    controller.enable();
    controller.sync([critical()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(controller.isEnabled).toBe(false);
    clock.advance(10 * 60_000);
    expect(escalation.plays).toBe(1);
  });

  it('disable() stops everything', () => {
    const { controller, escalation, clock } = setup();
    controller.enable();
    controller.sync([critical()]);
    controller.disable();
    clock.advance(10 * 60_000);
    expect(escalation.plays).toBe(1);
    expect(escalation.stops).toBe(1);
  });
});
