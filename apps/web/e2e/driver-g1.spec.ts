import { expect, test } from '@playwright/test';
import { actorPage, expectCommandContract } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { offerOf, requestRetrieval } from './support/driver';
import { createFake, SEED_IDS } from './support/fake';
import { G1, runG1Path } from './support/g1';

/**
 * PNT-035 acceptance 1–2 (the G1 path of 16 / TC-057, on the paper channel) on the fake backend: the shared
 * UI path of support/g1.ts — every command press checked for one request with a UUIDv4 Idempotency-Key and
 * a disabled, busy button until the (delayed) reply — then the actors, the custody chain of the ticket and
 * its cycle and one audit row per command on the fake's world. The same path against the real API, with
 * these checks in SQL, is `e2e/live/g1.live.spec.ts` (PNT-036).
 */
runOnlyAt390();
fakeOnly();

test('G1 at 390 px: DRV1 takes in and parks on paper; DRV2 accepts, retrieves and hands over', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fake = createFake();
  const drv1 = await actorPage(browser, fake, 'DRV1');
  const drv2 = await actorPage(browser, fake, 'DRV2');
  const DRV1 = SEED_IDS.users.DRV1;
  const DRV2 = SEED_IDS.users.DRV2;

  const { ticketId } = await runG1Path(
    { page: drv1.page, log: fake },
    { page: drv2.page, log: fake },
    async (id) => {
      const ticket = fake.world.tickets.find((t) => t.id === id);
      expect(ticket).toMatchObject({
        status: 'parked',
        created_by: DRV1,
        parked_by: DRV1,
        key_tag: G1.keyTag,
      });
      expect(
        fake.world.media.filter((m) => m.ticket_id === id && m.upload_status === 'uploaded'),
      ).toHaveLength(4);
      requestRetrieval(fake, id);
      expect(offerOf(fake, id)).toMatchObject({ mode: 'single', recipients: [DRV2] });
    },
  );

  // TC-057: the right actor on every record, the full custody chain, one audit row per command
  const ticket = fake.world.tickets.find((t) => t.id === ticketId);
  expect(ticket).toMatchObject({
    status: 'delivered',
    created_by: DRV1,
    parked_by: DRV1,
    retrieved_by: DRV2,
    delivered_by: DRV2,
  });
  const cycle = fake.world.cycles.find((c) => c.ticket_id === ticketId);
  expect(cycle).toMatchObject({
    accepted_by: DRV2,
    retrieved_by: DRV2,
    delivered_by: DRV2,
    outcome: 'delivered',
  });
  const who = (id: string) => fake.world.users.find((u) => u.id === id)?.key;
  const chain = fake.world.custody
    .filter((e) => e.ticket_id === ticketId)
    .map((e) => `${e.subject}: ${e.from.type} → ${e.to.type} (${e.reason}) by ${who(e.actor_id)}`);
  expect(chain).toEqual([
    'vehicle: customer → driver (intake) by DRV1',
    'key: customer → driver (intake) by DRV1',
    'vehicle: driver → spot (parked) by DRV1',
    'key: driver → key_slot (key_deposited) by DRV1',
    'key: key_slot → driver (key_pickup) by DRV2',
    'vehicle: spot → driver (retrieval_start) by DRV2',
    'vehicle: driver → customer (handover) by DRV2',
    'key: driver → customer (handover) by DRV2',
  ]);
  const audit = fake.world.audit.map((a) => `${a.route} by ${who(a.actor_id)}`);
  for (const route of [
    'POST /v1/tickets',
    'PATCH /v1/tickets/:ticketId/intake',
    'POST /v1/tickets/:ticketId/submit-intake',
    'POST /v1/tasks/:taskId/complete-parking',
  ])
    expect(audit).toContain(`${route} by DRV1`);
  for (const route of [
    'POST /v1/task-offers/:offerId/accept',
    'POST /v1/tasks/:taskId/key-pickup',
    'POST /v1/tasks/:taskId/start-retrieval',
    'POST /v1/tasks/:taskId/ready',
    'POST /v1/tickets/:ticketId/handover',
  ])
    expect(audit).toContain(`${route} by DRV2`);
  expect(fake.world.duties.find((d) => d.user_id === DRV2 && d.status === 'on_duty')).toBeTruthy();
  expectCommandContract(fake, ['POST /v1/tickets/:ticketId/media', 'POST /v1/media/:mediaId/complete']);
});
