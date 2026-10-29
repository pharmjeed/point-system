import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hasIncidentOpener, openIncident, openIncidentViaHook, registerIncidentOpener } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  createS2App,
  EVT_R1,
  EVT_R2,
  ok,
  one,
  POOL_R,
  rows,
  RMS,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { CASH, cashHandover, deliveredWith, FEE, onBreak, POS, reverse } from './payments-fixtures.js';
import { readyRetrieval } from './supervisor-fixtures.js';

/**
 * One incident writer (consolidation of the S3, S4 and payments writers into the incidents module's
 * `openIncident`, 11 §6.11): every flow that opens an incident inside its command goes through it — the use-cases
 * directly, payments-reports through the core seam (04 §4.3) — and each keeps the rows and the events it
 * documented before: TT-19 (exception handover: resolved, owned by the supervisor, on the ticket timeline, no
 * `auto_created`), TT-20 (repark: resolved, `low`, both payloads `resolved` + `auto_created`), 13 §7.1 / §10.2
 * (payment discrepancy: open, the event's pool on the envelope, `auto_created`).
 */

const envelopes = (t: TestApp, type: string, incidentId: string) =>
  rows(t.db, `SELECT payload FROM outbox_events WHERE type = $1 AND aggregate_id = $2 ORDER BY seq`, [
    type,
    incidentId,
  ]).then((r) => r.map((x) => x.payload));

const timelineOf = (t: TestApp, ticketId: string) =>
  rows(
    t.db,
    `SELECT type, actor_type, actor_id, ticket_version, data FROM ticket_events
      WHERE ticket_id = $1 AND type LIKE 'incident.%' ORDER BY id`,
    [ticketId],
  );

describe('incident writer — the system-opened incidents go through openIncident()', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201); // longest idle: the retrievals go to him
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  it('TT-19: the exception handover documents a resolved lost_ticket incident on the ticket timeline', async () => {
    const r = await readyRetrieval(t, { parker: 'DRV2', driver: 'DRV1', eventId: EVT_R1 });
    const ready = await one(t.db, `SELECT version FROM tickets WHERE id = $1`, [r.ticketId]);
    t.clock.advanceSeconds(30);
    ok(
      await t.command('post', `/v1/tickets/${r.ticketId}/handover-exception`, {
        as: 'SUP-R',
        body: {
          reason: 'فقد العميل الكعب',
          identity_checks: { plate_confirmed: true, vehicle_description_confirmed: true },
        },
      }),
    );
    const now = t.clock.now();
    const incident = await one(t.db, `SELECT * FROM incidents WHERE ticket_id = $1`, [r.ticketId]);
    expect(incident).toMatchObject({
      venue_id: RMS,
      event_id: EVT_R1,
      type: 'lost_ticket',
      status: 'resolved',
      severity: 'medium',
      description: 'فقد العميل الكعب',
      opened_by: U['SUP-R'],
      owner_id: U['SUP-R'],
      resolution: 'handover_exception: plate, vehicle_description',
      resolved_by: U['SUP-R'],
      resolved_at: now,
      closed_at: null,
      version: 1,
      created_at: now,
      updated_at: now,
    });
    const payload = (status: string) => ({
      incident_id: incident.id,
      type: 'lost_ticket',
      status,
      severity: 'medium',
      ticket_id: r.ticketId,
    });
    for (const [type, status] of [
      ['incident.opened', 'open'],
      ['incident.resolved', 'resolved'],
    ] as const) {
      const [env, ...more] = await envelopes(t, type, incident.id);
      expect(more).toEqual([]);
      expect(env).toMatchObject({
        type,
        occurred_at: now.toISOString(),
        venue_id: RMS,
        dispatch_pool_id: POOL_R,
        event_id: EVT_R1,
        aggregate: { type: 'incident', id: incident.id, version: 1 },
        actor: { type: 'user', id: U['SUP-R'] },
      });
      expect(env.payload).toEqual(payload(status)); // no auto_created key, as TT-19 documents it
    }
    // both events on the ticket timeline, at the version of the ready ticket (tickets-custody emitForTicket)
    expect(await timelineOf(t, r.ticketId)).toEqual([
      {
        type: 'incident.opened',
        actor_type: 'user',
        actor_id: U['SUP-R'],
        ticket_version: ready.version,
        data: payload('open'),
      },
      {
        type: 'incident.resolved',
        actor_type: 'user',
        actor_id: U['SUP-R'],
        ticket_version: ready.version,
        data: payload('resolved'),
      },
    ]);
  });

  it('TT-20: the repark documents a resolved customer_absent incident (both payloads resolved, auto_created)', async () => {
    const r = await readyRetrieval(t, { parker: 'DRV2', driver: 'DRV1', eventId: EVT_R1 });
    t.clock.advanceSeconds(600);
    ok(
      await t.command('post', `/v1/tickets/${r.ticketId}/repark`, {
        as: 'SUP-R',
        body: { reason: 'العميل لم يحضر' },
      }),
    );
    const now = t.clock.now();
    const incident = await one(t.db, `SELECT * FROM incidents WHERE ticket_id = $1`, [r.ticketId]);
    expect(incident).toMatchObject({
      venue_id: RMS,
      event_id: EVT_R1,
      type: 'customer_absent',
      status: 'resolved',
      severity: 'low',
      description: 'العميل لم يحضر',
      opened_by: U['SUP-R'],
      owner_id: U['SUP-R'],
      resolution: 'repark',
      resolved_by: U['SUP-R'],
      resolved_at: now,
      version: 1,
    });
    for (const type of ['incident.opened', 'incident.resolved']) {
      const [env, ...more] = await envelopes(t, type, incident.id);
      expect(more).toEqual([]);
      expect(env).toMatchObject({
        type,
        venue_id: RMS,
        dispatch_pool_id: null,
        event_id: EVT_R1,
        aggregate: { type: 'incident', id: incident.id, version: 1 },
        actor: { type: 'user', id: U['SUP-R'] },
      });
      expect(env.payload).toEqual({
        incident_id: incident.id,
        type: 'customer_absent',
        status: 'resolved',
        severity: 'low',
        ticket_id: r.ticketId,
        auto_created: true,
      });
    }
    expect(await timelineOf(t, r.ticketId)).toEqual([]); // TT-20 keeps them off the timeline
    const audit = await one(
      t.db,
      `SELECT metadata FROM audit_log WHERE action = 'ticket.repark' AND entity_id = $1`,
      [r.ticketId],
    );
    expect(audit.metadata.incident_id).toBe(incident.id);
  });

  it('13 §7.1 / §10.2: payment discrepancies are open, on the event pool, auto_created, through the core seam', async () => {
    ok(await onBreak(t, 'DRV2', true)); // DRV1 takes in, parks and brings every car of this case
    const a = await deliveredWith(t, 'DRV1', POS());
    ok(await reverse(t, 'SUP-R', a.paymentId, { reason: 'عملية الشبكة أُلغيت' }));
    await deliveredWith(t, 'DRV1', CASH);
    const h = ok(
      await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE - 500 }),
      201,
    );
    const pool = (await one(t.db, `SELECT dispatch_pool_id FROM events WHERE id = $1`, [EVT_R2]))
      .dispatch_pool_id;
    const incidents = await rows(
      t.db,
      `SELECT * FROM incidents WHERE type = 'payment_discrepancy' ORDER BY created_at, ticket_id NULLS LAST`,
    );
    expect(incidents.map((i) => [i.ticket_id, i.status, i.severity, i.owner_id, i.opened_by])).toEqual([
      [a.ticketId, 'open', 'medium', null, U['SUP-R']],
      [null, 'open', 'medium', null, U['SUP-R']],
    ]);
    expect(incidents[1].id).toBe(h.incident_id);
    for (const i of incidents) {
      const [env, ...more] = await envelopes(t, 'incident.opened', i.id);
      expect(more).toEqual([]);
      expect(env).toMatchObject({
        venue_id: RMS,
        dispatch_pool_id: pool,
        event_id: EVT_R2,
        aggregate: { type: 'incident', id: i.id, version: 1 },
        actor: { type: 'user', id: U['SUP-R'] },
      });
      expect(env.payload).toEqual({
        incident_id: i.id,
        type: 'payment_discrepancy',
        status: 'open',
        severity: 'medium',
        ticket_id: i.ticket_id,
        auto_created: true,
      });
      expect(await envelopes(t, 'incident.resolved', i.id)).toEqual([]);
    }
  });

  it('the core seam is filled by the incidents module and refuses to skip an incident without it', async () => {
    expect(hasIncidentOpener()).toBe(true);
    registerIncidentOpener(null);
    try {
      await expect(
        t.db.transaction((tx) =>
          openIncidentViaHook(tx, {
            orgId: 'x',
            venueId: 'x',
            type: 'other',
            description: 'x',
            openedBy: 'x',
          }),
        ),
      ).rejects.toThrow(/no incident writer is registered/);
    } finally {
      registerIncidentOpener(openIncident);
    }
    expect(hasIncidentOpener()).toBe(true);
    expect(await rows(t.db, `SELECT id FROM incidents`)).toEqual([]);
  });
});

describe('incident writer — structure', () => {
  const src = join(import.meta.dirname, '../../../packages/server/src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('only the incidents module inserts incidents (one writer, 04 §4.2 item 7)', () => {
    const writers = files(src)
      .filter((f) => /INSERT\s+INTO\s+incidents\b/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f));
    expect(writers).toEqual(['modules/incidents/application/incidents.service.ts']);
  });
});
