import { SystemMonitor, createLogger, metrics, type Tx } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerCopy } from './test-env.js';
import {
  createCustomerApp,
  freshDriver,
  messagesTo,
  onDuty,
  settle,
  ticketRow,
  whatsappTicket,
  type CustomerApp,
} from './customer-harness.js';
import { addPhotos, newDraft, ok, PAPER_DRAFT, patchIntake, submitIntake } from './dispatch-fixtures.js';
import { ORG } from './wa-harness.js';

let phoneSeq = 3_700_000;
const newPhone = () => `+96655${phoneSeq++}`;
const silent = createLogger({ level: 'silent' });

/**
 * GAP-9 end to end: the quota gauges of 12 §13 count what the real sender writes. A direct W-01 (staff-initiated,
 * the customer never wrote) reaches a user outside the service window; the W-01 of a QR link follows the customer's
 * own message and does not (12 §7.2, F-18); the session replies W-10 and W-11 are service messages (F-03).
 */
describe('GAP-9 — the WhatsApp quota gauges over the real send path', () => {
  let w: CustomerApp;
  let monitor: SystemMonitor;
  const quota = async () =>
    (await w.db.transaction((tx: Tx) => monitor.waQuota(tx))).find((q) => q.orgId === ORG)!;

  beforeAll(async () => {
    w = await createCustomerApp();
    await onDuty(w, 'DRV2', 'DRV7');
    monitor = new SystemMonitor(w.db, w.clock, silent, { retentionCron: null, quotaRefreshMs: 0 });
  });
  afterAll(async () => w?.close());

  it('direct W-01 counts one user outside the window; the QR W-01 does not; W-10 and W-11 are service messages', async () => {
    const start = await quota();

    // direct link with verbal consent: the template goes to a customer who never wrote to «مصاف»
    const direct = newPhone();
    const t = await whatsappTicket(w, await freshDriver(w), direct);
    expect(t.submit!.status).toBe(200);
    await settle(w, direct);
    expect((await messagesTo(w, direct)).map((m) => m.purpose)).toEqual(['W-01']);
    let q = await quota();
    expect(q.uniqueUsers24hOutsideWindow).toBe(start.uniqueUsers24hOutsideWindow + 1);
    expect(q.serviceMessagesMonth).toBe(start.serviceMessagesMonth);

    // QR: the customer's message opens the window, W-11 answers it, the confirmed W-01 follows inside the window
    const drv = await freshDriver(w);
    const d = await newDraft(w, drv);
    const p = ok(
      await patchIntake(w, drv, d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT('X', 'QUOTA-QR', '3999'),
        channel: 'whatsapp',
        paper_serial: null,
      }),
    );
    await addPhotos(w.db, d.ticketId, drv);
    const qr = ok(
      await w.command('post', `/v1/tickets/${d.ticketId}/whatsapp-link`, { as: drv, body: { method: 'qr' } }),
    ).qr;
    ok(await submitIntake(w, drv, d.ticketId, { expected_version: p.version as number }));
    const viaQr = newPhone();
    await w.sim.client.sendLinkCode(viaQr, qr.code, { timestamp: w.ts() });
    await w.drain();
    ok(
      await w.command('post', `/v1/tickets/${d.ticketId}/whatsapp-link/confirm`, {
        as: drv,
        body: { link_code_id: qr.link_code_id, matches: true },
      }),
    );
    await settle(w, viaQr);
    expect((await messagesTo(w, viaQr)).map((m) => m.purpose ?? m.renderedText)).toEqual([
      customerCopy.messageText('W-11', 'received'),
      'W-01',
    ]);
    expect((await ticketRow(w, d.ticketId)).wa_link_status).toBe('linked');

    // a free text from someone else gets the W-10 guidance
    const stranger = newPhone();
    await w.sim.client.sendText({ from: stranger, body: 'السلام عليكم', timestamp: w.ts() });
    await settle(w, stranger);
    expect((await messagesTo(w, stranger)).map((m) => m.renderedText)).toEqual([
      customerCopy.messageText('W-10'),
    ]);

    q = await quota();
    expect(q.uniqueUsers24hOutsideWindow).toBe(start.uniqueUsers24hOutsideWindow + 1); // the QR W-01 is not counted
    expect(q.serviceMessagesMonth).toBe(start.serviceMessagesMonth + 2); // W-11 and W-10

    // the gauges carry the same numbers
    await monitor.refreshGauges();
    expect((await metrics.waUniqueUsers24h.get()).values[0]?.value).toBe(q.uniqueUsers24hOutsideWindow);
    expect((await metrics.waServiceMessagesMonth.get()).values[0]?.value).toBe(q.serviceMessagesMonth);
  });
});
