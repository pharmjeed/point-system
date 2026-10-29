import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LYL, ORG, RMS, createTicket, createWaTestApp, emit, type WaTestApp } from './wa-harness.js';

/**
 * 14 §8 `wa_webhook_silent` (DEC-146, 15 §12 «توقف الـWebhooks»): when the sender has a message accepted, it checks
 * (at most once a minute per process) whether a send accepted 10 or more minutes ago has had no webhook since — the
 * last webhook, or 24 h back when there was none; if so, one critical row per venue with an open or closing event.
 * Any processed webhook resolves them (15 §15 item 12: raised and closed automatically).
 */
describe('wa_webhook_silent — raised by the sender, resolved by any webhook', () => {
  let w: WaTestApp;
  let seq = 0;

  beforeAll(async () => {
    w = await createWaTestApp();
    await w.syncTemplates();
    await w.db.query(`UPDATE events SET status = 'open', closed_at = NULL WHERE org_id = $1`, [ORG]);
  });
  afterAll(async () => w?.close());

  /** a W-01 to a new customer, accepted by the simulator (no status webhook: autoStatuses is off) */
  const sendTemplate = async (): Promise<string> => {
    const n = ++seq;
    const customerId = (
      await w.db.query<{ id: string }>(
        `INSERT INTO customers (org_id, phone_e164, wa_id) VALUES ($1, $2, $3) RETURNING id`,
        [ORG, `+96655810${String(n).padStart(4, '0')}`, `96655810${String(n).padStart(4, '0')}`],
      )
    ).rows[0]!.id;
    const t = await createTicket(w, { status: 'parking', waLinkStatus: 'pending_send', customerId });
    await emit(w, 'ticket.intake_submitted', t, {
      channel: 'whatsapp',
      inspection_status: 'complete',
      payment_status: 'not_required',
      wa_link_status: 'pending_send',
    });
    await w.flush();
    const m = await w.db.query<{ wa_message_id: string | null }>(
      `SELECT wa_message_id FROM whatsapp_messages WHERE ticket_id = $1 AND direction = 'outbound'`,
      [t.id],
    );
    expect(m.rows[0]?.wa_message_id).toBeTruthy();
    return m.rows[0]!.wa_message_id!;
  };
  const silent = async () =>
    (
      await w.db.query<{
        venue_id: string;
        status: string;
        severity: string;
        details: any;
        resolved_by: string | null;
      }>(
        `SELECT venue_id, status, severity, details, resolved_by FROM alerts
          WHERE type = 'wa_webhook_silent' ORDER BY raised_at, venue_id`,
      )
    ).rows;

  it('a send 10 minutes unanswered raises one critical row per venue with an open event; a webhook resolves them', async () => {
    const first = await sendTemplate(); // nothing older is unanswered
    expect(await silent()).toEqual([]);

    // 11 minutes later, still no webhook: the next acceptance finds the first send unanswered
    w.clock.advanceSeconds(11 * 60);
    await sendTemplate();
    let rows = await silent();
    expect(rows.map((a) => [a.venue_id, a.status, a.severity])).toEqual(
      [RMS, LYL].sort().map((v) => [v, 'open', 'critical']),
    );
    expect(rows[0]!.details.last_webhook_at).toBeNull(); // no webhook in the last 24 h
    const raised = await w.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'alert.raised' AND payload->'payload'->>'type' = 'wa_webhook_silent'`,
    );
    expect(raised.rows[0].n).toBe(2);

    // at most one check a minute per process, and one live row per venue
    w.clock.advanceSeconds(30);
    await sendTemplate();
    expect(await silent()).toHaveLength(2);

    // any webhook ends it (a status of the first message)
    await w.sim.client.emitStatuses({ wamid: first, statuses: ['delivered'], timestamp: w.ts() });
    await w.flush();
    rows = await silent();
    expect(rows.map((a) => [a.status, a.resolved_by])).toEqual([
      ['resolved', null],
      ['resolved', null],
    ]);
  });

  it('not raised while webhooks are recent; raised again once a send stays 10 minutes unanswered after the last one', async () => {
    const before = (await silent()).length;
    // a webhook 2 minutes ago: the check returns early whatever was sent before
    const wamid = await sendTemplate();
    await w.sim.client.emitStatuses({ wamid, statuses: ['sent'], timestamp: w.ts() });
    await w.flush();
    w.clock.advanceSeconds(2 * 60);
    await sendTemplate();
    expect(await silent()).toHaveLength(before);

    // 11 minutes after that send, with no webhook since the last one: raised again (new rows, live)
    w.clock.advanceSeconds(11 * 60);
    await sendTemplate();
    const rows = await silent();
    expect(rows).toHaveLength(before + 2);
    const live = rows.filter((a) => a.status !== 'resolved');
    expect(live.map((a) => a.venue_id)).toEqual([RMS, LYL].sort());
    expect(typeof live[0]!.details.last_webhook_at).toBe('string');
  });
});
