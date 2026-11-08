import { expect, test, type Page } from '@playwright/test';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { requestRetrieval } from './support/driver';
import { audioLog, installFakeAudio } from './support/fakeAudio';
import { createFake, type SeedUserKey } from './support/fake';
import { busyDriver, expectOneOffer, offerCardOf, parkedCars } from './support/live';

/**
 * 17 TC-042 (AC-14 — البث): four drivers of one pool, each in his own browser context, receive the same
 * broadcast; one of them reserves it from his card; `task.claimed` must reach the other three, whose card must
 * leave the screen and whose sound must stop within 3 seconds (p95 over the iterations).
 *
 * The fake backend and its realtime hub (`fake.realtime`, Socket.IO frames over `page.routeWebSocket`) play the
 * API; the AudioContext is the recording stand-in of support/fakeAudio.ts. One sample = one losing driver in one
 * iteration: from the server-side commit of the winning accept (`FakeCall.at` of the winner's
 * `POST /v1/task-offers/:offerId/accept`) to the later of (a) the card leaving the DOM (a MutationObserver
 * installed before the app loads, last «gone» transition) and (b) the `broadcast` source stopped
 * (`stoppedAt`). Same machine, same wall clock (`Date.now()`) in the test process and in the pages.
 *
 * Iterations: `TC042_ITERATIONS` (17 asks 50). The default is 50, so the normal suite runs the full TC-042
 * (about 55 s at 390 px on the fake, ~1 s per iteration; the test timeout grows with the count); set e.g.
 * `TC042_ITERATIONS=5` for a quick local run.
 * Between iterations the supervisor cancels the reserved request (`POST /v1/retrieval-cycles/{id}/cancel`),
 * which frees the winner's next-task slot, and the same car is requested again; the winner rotates over the
 * four drivers.
 */
runOnlyAt390();
fakeOnly();

const ITERATIONS = Math.max(1, Number(process.env.TC042_ITERATIONS ?? 50) || 50);
const BUDGET_MS = 3000;
const DRIVERS: SeedUserKey[] = ['DRV1', 'DRV2', 'DRV4', 'DRV5']; // DRV3 parks the car, then goes on break
const ACCEPT = 'POST /v1/task-offers/:offerId/accept';
/** Short poll steps: the loop waits on many quick conditions (the measurement itself is taken in the pages). */
const FAST = { intervals: [25, 50, 100] };

/** Records every appearance / disappearance of the D-04 head card (`section.pt-offer`) with `Date.now()`. */
async function installCardObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log = { shown: [] as number[], gone: [] as number[] };
    (window as unknown as { __cards: typeof log }).__cards = log;
    let present = false;
    const check = () => {
      const now = document.querySelector('section.pt-offer') !== null;
      if (now === present) return;
      present = now;
      (now ? log.shown : log.gone).push(Date.now());
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
}

function cardLog(page: Page): Promise<{ shown: number[]; gone: number[] }> {
  return page.evaluate(() => (window as unknown as { __cards: { shown: number[]; gone: number[] } }).__cards);
}

const count = (list: string[], name: string) => list.filter((n) => n === name).length;

/** p95 by nearest rank. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number;
}

test('TC-042 / AC-14: a broadcast claimed by one driver leaves the other three cards and stops their sound within 3 s (p95)', async ({
  browser,
}) => {
  test.setTimeout(60_000 + ITERATIONS * 5_000);
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  for (const key of DRIVERS) busyDriver(fake, key); // busy: a request is broadcast («حجز كمهمة تالية»)

  const drivers: Array<{ key: SeedUserKey; id: string; page: Page }> = [];
  for (const key of DRIVERS) {
    const { page } = await actorPage(browser, fake, key);
    await installFakeAudio(page);
    await installCardObserver(page);
    await page.goto('/d');
    await page.getByRole('button', { name: 'تفعيل الصوت' }).click(); // the unlock tap (PNT-066)
    await expect.poll(async () => (await audioLog(page)).started).toEqual(['test']);
    drivers.push({ key, id: fake.userByKey(key).id, page });
  }
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(DRIVERS.length);

  const samples: number[] = [];
  const perIteration: Array<{ winner: SeedUserKey; ms: number[] }> = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    requestRetrieval(fake, car!.ticketId);
    const task = fake.world.tasks.find(
      (k) => k.ticket_id === car!.ticketId && k.type === 'retrieve' && k.status === 'broadcast',
    );
    expect(task, `iteration ${i}: a broadcast round`).toBeTruthy();
    const offer = fake.world.offers.find((o) => o.task_id === task!.id && o.status === 'active');
    expect(offer?.mode).toBe('broadcast');

    // every one of the four has the card on screen and its `broadcast` sound playing
    for (const d of drivers) {
      await expectOneOffer(d.page, car!.displayNumber);
      await expect
        .poll(async () => count((await audioLog(d.page)).started, 'broadcast'), {
          ...FAST,
          message: `${d.key} plays the broadcast sound`,
        })
        .toBe(i + 1);
      expect(count((await audioLog(d.page)).stopped, 'broadcast')).toBe(i);
    }

    // one of them reserves it from his card
    const winner = drivers[i % drivers.length]!;
    const losers = drivers.filter((d) => d !== winner);
    const accepts = fake.callsTo(ACCEPT).length;
    const claimedBefore = fake.realtime.delivered.length;
    await offerCardOf(winner.page).getByRole('button', { name: 'حجز كمهمة تالية' }).click();
    await expect.poll(() => fake.callsTo(ACCEPT).length, FAST).toBe(accepts + 1);
    const call = fake.callsTo(ACCEPT).at(-1)!;
    await expect.poll(() => call.status, FAST).toBe(200);
    const committedAt = call.at;

    const ms: number[] = [];
    for (const d of losers) {
      // `task.claimed` reached him (07 §4.2), for this task, naming the winner
      await expect
        .poll(
          () =>
            fake.realtime.delivered
              .slice(claimedBefore)
              .filter((x) => x.userId === d.id && x.type === 'task.claimed').length,
          FAST,
        )
        .toBe(1);
      const claimed = fake.realtime.delivered
        .slice(claimedBefore)
        .find((x) => x.userId === d.id && x.type === 'task.claimed')!;
      expect(claimed.frame.payload).toMatchObject({
        task_id: task!.id,
        offer_ids: [offer!.id],
        claimed_by: { id: winner.id },
      });
      // the card leaves and the sound stops (the poll is generous; the 3 s budget is checked on the samples)
      await expect(offerCardOf(d.page)).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(async () => count((await audioLog(d.page)).stopped, 'broadcast'), { ...FAST, timeout: 10_000 })
        .toBe(i + 1);
      const audio = await audioLog(d.page);
      const stoppedAt = audio.stoppedAt.filter((_, j) => audio.stopped[j] === 'broadcast').at(-1)!;
      const goneAt = (await cardLog(d.page)).gone.at(-1)!;
      expect(goneAt, `${d.key}: the card left after the commit`).toBeGreaterThanOrEqual(committedAt);
      expect(stoppedAt, `${d.key}: the sound stopped after the commit`).toBeGreaterThanOrEqual(committedAt);
      ms.push(Math.max(goneAt, stoppedAt) - committedAt);
    }
    // the winner gets no task.claimed of his own claim
    expect(
      fake.realtime.delivered
        .slice(claimedBefore)
        .filter((x) => x.userId === winner.id && x.type === 'task.claimed'),
    ).toHaveLength(0);
    samples.push(...ms);
    perIteration.push({ winner: winner.key, ms });

    // reset: the supervisor cancels the reserved request (the winner's next-task slot is free again)
    const cycle = fake.world.cycles.find((c) => c.ticket_id === car!.ticketId && !c.closed_at)!;
    fake.exec(
      'SUP-R',
      'POST /v1/retrieval-cycles/:cycleId/cancel',
      { cycleId: cycle.id },
      { reason: 'إعادة الاختبار TC-042' },
    );
  }

  const result = {
    iterations: ITERATIONS,
    samples: samples.length,
    p95_ms: p95(samples),
    max_ms: Math.max(...samples),
    median_ms: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
  };
  test.info().annotations.push({ type: 'TC-042', description: JSON.stringify(result) });
  await test.info().attach('tc-042-latencies.json', {
    body: JSON.stringify({ ...result, perIteration }, null, 2),
    contentType: 'application/json',
  });
  console.log(`TC-042: ${JSON.stringify(result)}`);
  expect(samples).toHaveLength(ITERATIONS * (DRIVERS.length - 1));
  expect(result.p95_ms, `p95 of ${samples.length} samples`).toBeLessThanOrEqual(BUDGET_MS);

  for (const d of drivers) await d.page.context().close();
});
