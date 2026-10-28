import { describe, expect, it } from 'vitest';
import { LockTracker } from '../src/core/db/lock-tracker.js';

describe('lock order (canon §14ب)', () => {
  it('allows ascending levels', () => {
    const t = new LockTracker();
    for (const table of [
      'dispatch_pools',
      'events',
      'users',
      'tasks',
      'tickets',
      'retrieval_cycles',
      'task_offers',
      'duty_sessions',
    ] as const) {
      t.check(table);
      t.record(table, ['x']);
    }
  });

  it('rejects a lower level after a higher one', () => {
    const t = new LockTracker();
    t.record('tickets', ['x']);
    expect(() => t.check('tasks')).toThrow(/lock order violation/);
    expect(() => t.check('dispatch_pools')).toThrow(/lock order violation/);
  });

  it('a transaction holding L1 may lock extra L4–L8 rows later (dispatch pass exception) but not L2/L3', () => {
    const t = new LockTracker();
    t.record('dispatch_pools', ['p']);
    t.record('duty_sessions', ['d']);
    expect(() => t.check('tasks')).not.toThrow();
    expect(() => t.check('task_offers')).not.toThrow();
    expect(() => t.check('events')).toThrow();
    expect(() => t.check('users')).toThrow();
  });
});
