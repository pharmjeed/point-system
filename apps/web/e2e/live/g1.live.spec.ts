import { expect } from '@playwright/test';
import { expectCommandContract } from '../support/actors';
import { liveExec, liveSignIn, WEB_ORIGIN } from '../support/backend';
import type { LoggedCall } from '../support/commandLog';
import { SEED_IDS } from '../support/fake/seed';
import { G1, runG1Path } from '../support/g1';
import { livePage, test } from './fixtures';

/**
 * PNT-036 — gate G1 (16, 17 TC-057) against the real API and a seeded PostgreSQL: DRV1 and DRV2 sign in
 * through D-01 with their development-seed PINs and run the shared UI path of support/g1.ts (paper intake
 * and park by DRV1; SUP-R requests on behalf through the API; DRV2 accepts the single offer, picks the key
 * up, starts, marks ready and hands over against the stub). Then, in SQL: `created_by = parked_by = DRV1`,
 * `retrieved_by = delivered_by = DRV2` on the ticket and the cycle, the full custody chain customer → DRV1 →
 * spot / key slot → DRV2 → customer, and one audit row per command — matched by the request id of every
 * command the browsers sent.
 */
const U = SEED_IDS.users;

test('G1 through the real API: DRV1 takes in and parks on paper; DRV2 accepts, retrieves and hands over', async ({
  browser,
  playwright,
  live,
}) => {
  test.setTimeout(180_000);
  const drv1 = await livePage(browser, live, 'DRV1');
  const drv2 = await livePage(browser, live, 'DRV2');
  const supervisor = await playwright.request.newContext({ baseURL: WEB_ORIGIN });
  await liveSignIn(supervisor, 'SUP-R');

  const { ticketId } = await runG1Path(drv1, drv2, async (id) => {
    const parked = await live.sql(
      `SELECT status, created_by, parked_by, key_tag FROM tickets WHERE id = $1`,
      [id],
    );
    expect(parked).toEqual([{ status: 'parked', created_by: U.DRV1, parked_by: U.DRV1, key_tag: G1.keyTag }]);
    const photos = await live.sql<{ kind: string }>(
      `SELECT kind FROM media_assets WHERE ticket_id = $1 AND upload_status = 'uploaded' ORDER BY kind`,
      [id],
    );
    expect(photos.map((p) => p.kind)).toEqual(['photo_front', 'photo_left', 'photo_rear', 'photo_right']);
    await liveExec(
      supervisor,
      'POST /v1/tickets/:ticketId/retrievals',
      { ticketId: id },
      { reason: 'العميل حضر بتذكرة ورقية' },
    );
    // DEC-08: the pass ran in the same transaction — a single offer to the longest-idle driver
    const offers = await live.sql(
      `SELECT o.mode, r.user_id FROM task_offers o JOIN tasks t ON t.id = o.task_id
         JOIN offer_recipients r ON r.offer_id = o.id
        WHERE t.ticket_id = $1 AND o.status = 'active'`,
      [id],
    );
    expect(offers).toEqual([{ mode: 'single', user_id: U.DRV2 }]);
  });

  // every actor in its own column (AC-19)
  const [ticket] = await live.sql(`SELECT * FROM tickets WHERE id = $1`, [ticketId]);
  expect(ticket).toMatchObject({
    status: 'delivered',
    channel: 'paper',
    paper_serial: G1.serial,
    inspection_status: 'complete',
    created_by: U.DRV1,
    parked_by: U.DRV1,
    retrieved_by: U.DRV2,
    delivered_by: U.DRV2,
    vehicle_holder_type: 'customer',
    key_holder_type: 'customer',
  });
  const [cycle] = await live.sql(`SELECT * FROM retrieval_cycles WHERE ticket_id = $1`, [ticketId]);
  expect(cycle).toMatchObject({
    requested_by_user_id: U['SUP-R'],
    accepted_by: U.DRV2,
    retrieved_by: U.DRV2,
    delivered_by: U.DRV2,
    handover_method: 'paper_stub',
    outcome: 'delivered',
  });

  // the full custody chain, in order, with its actor: customer → DRV1 → spot / key slot → DRV2 → customer
  const chain = await live.sql<{ subject: string; f: string; t: string; reason: string; actor_id: string }>(
    `SELECT subject, from_holder_type AS f, to_holder_type AS t, reason, actor_id
       FROM custody_events WHERE ticket_id = $1 ORDER BY occurred_at, subject DESC`,
    [ticketId],
  );
  const who = (id: string) => Object.entries(U).find(([, v]) => v === id)?.[0];
  const line = (subject: string) =>
    chain
      .filter((c) => c.subject === subject)
      .map((c) => `${c.f} → ${c.t} (${c.reason}) by ${who(c.actor_id)}`);
  expect(line('vehicle')).toEqual([
    'customer → driver (intake) by DRV1',
    'driver → spot (parked) by DRV1',
    'spot → driver (retrieval_start) by DRV2',
    'driver → customer (handover) by DRV2',
  ]);
  expect(line('key')).toEqual([
    'customer → driver (intake) by DRV1',
    'driver → key_slot (key_deposited) by DRV1',
    'key_slot → driver (key_pickup) by DRV2',
    'driver → customer (handover) by DRV2',
  ]);

  // one audit row per command: every successful command of both browsers, by its request id and actor
  const commands = (calls: readonly LoggedCall[]) =>
    calls.filter(
      (c) => c.method !== 'GET' && !c.path.startsWith('/v1/auth/') && c.status >= 200 && c.status < 300,
    );
  const sent = [
    ...commands(drv1.log.calls).map((c) => ({ ...c, actor: U.DRV1 })),
    ...commands(drv2.log.calls).map((c) => ({ ...c, actor: U.DRV2 })),
  ];
  expect(sent.length).toBeGreaterThanOrEqual(16);
  for (const c of sent) {
    expect(c.requestId, `${c.method} ${c.path} request id`).toBeTruthy();
    const rows = await live.sql<{ actor_id: string }>(
      `SELECT actor_id FROM audit_log WHERE request_id = $1`,
      [c.requestId],
    );
    expect(rows, `${c.method} ${c.path}: one audit row`).toEqual([{ actor_id: c.actor }]);
  }
  const onBehalf = await live.sql(
    `SELECT actor_id FROM audit_log WHERE action = 'retrieval.request_on_behalf' AND entity_id = $1`,
    [ticketId],
  );
  expect(onBehalf).toEqual([{ actor_id: U['SUP-R'] }]);

  expectCommandContract(drv1.log, ['POST /v1/tickets/:ticketId/media', 'POST /v1/media/:mediaId/complete']);
  expectCommandContract(drv2.log, ['POST /v1/tickets/:ticketId/handover']);
  await supervisor.dispose();
});
