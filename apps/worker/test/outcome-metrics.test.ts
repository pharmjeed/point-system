import { metrics } from '@point/server';
import { describe, expect, it } from 'vitest';
import { countOutboxOutcome } from '../src/worker.js';

const count = async (type: string, status: string) =>
  (await metrics.outboxEvents.get()).values.find((v) => v.labels.type === type && v.labels.status === status)
    ?.value ?? 0;

/** 05 §12.2 `point_outbox_events_total{type,status}`: processing results (done, failed, dead, canceled). */
describe('point_outbox_events_total', () => {
  it('counts a row once, by its result: a retry (the row back to pending) is not a failure', async () => {
    const type = 'job.wa_send';
    const before = {
      done: await count(type, 'done'),
      failed: await count(type, 'failed'),
      dead: await count(type, 'dead'),
    };
    // a template deferred twice by pacing, then accepted
    countOutboxOutcome({ type }, 'retry', 1000);
    countOutboxOutcome({ type }, 'retry', 1000);
    countOutboxOutcome({ type }, 'done', 40);
    expect(await count(type, 'failed')).toBe(before.failed);
    expect(await count(type, 'retry')).toBe(0);
    expect(await count(type, 'done')).toBe(before.done + 1);
    // a permanent failure and an exhausted row are results
    countOutboxOutcome({ type }, 'failed', 0);
    countOutboxOutcome({ type }, 'dead', 0);
    expect(await count(type, 'failed')).toBe(before.failed + 1);
    expect(await count(type, 'dead')).toBe(before.dead + 1);
  });

  it('timers report their lag on every lease, domain events do not', async () => {
    const lag = async (job: string) =>
      (await metrics.timerLag.get()).values.find(
        (v) => v.labels.job === job && v.metricName === 'point_timer_lag_seconds_count',
      )?.value ?? 0;
    const before = await lag('job.offer_expire');
    countOutboxOutcome({ type: 'job.offer_expire' }, 'retry', 2500);
    countOutboxOutcome({ type: 'job.offer_expire' }, 'done', 100);
    countOutboxOutcome({ type: 'ticket.created' }, 'done', 100);
    expect(await lag('job.offer_expire')).toBe(before + 2);
    expect(await lag('ticket.created')).toBe(0);
  });
});
