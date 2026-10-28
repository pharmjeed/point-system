import { SEED_IDS } from '@point/db/seed';
import { createLogger, RetentionPurger } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  auditCount,
  createS2App,
  err,
  EVT_L1,
  EVT_R2,
  LYL,
  ok,
  one,
  RMS,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { CASH, deliveredWith, exportsWorker, ORG, POS, reverse } from './payments-fixtures.js';

/**
 * PNT-089 (07 §2.7, 09 §3, 13 §13): audited CSV exports built by `job.export_generate` into the private exports
 * bucket, downloaded with a short signed link, expiring, and purged by the retention job.
 */

const PAYMENT_HEADER =
  'payment_id,event_name,event_date,venue_code,ticket_number,method,amount_sar,status,collected_by_code,' +
  'collected_by_name,collected_at_riyadh,pos_reference,reversed_at_riyadh,reversed_by_code,reversal_reason,cash_handover_id';

const createExport = (t: TestApp, as: string, body: unknown) =>
  t.command('post', '/v1/exports', { as, body });
const getExport = (t: TestApp, as: string, id: string) => t.get(`/v1/exports/${id}`, as);

/** CSV text → rows of cells (the test data has no quoted line breaks). */
function parseCsv(text: string): string[][] {
  const split = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  return text
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter((l) => l.length > 0)
    .map(split);
}

const riyadh = (d: Date | string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(d));

describe('PNT-089 — POST /v1/exports and GET /v1/exports/{exportId}', () => {
  let t: TestApp;
  let w: ReturnType<typeof exportsWorker>;
  beforeEach(async () => {
    t = await createS2App();
    w = exportsWorker(t);
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  /** Runs job.export_generate, recording whether a transaction was open during each storage call. */
  async function generate(): Promise<number[]> {
    const openTx: number[] = [];
    w.storage.beforeOperation = async () => {
      const q = await t.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
      );
      openTx.push(q.rows[0]!.n);
    };
    try {
      await w.worker.drain();
    } finally {
      w.storage.beforeOperation = null;
    }
    return openTx;
  }

  async function download(as: string, id: string) {
    const x = ok(await getExport(t, as, id));
    expect(x.status).toBe('ready');
    const res = w.storage.download(x.download_url);
    expect(res.status).toBe(200);
    return { view: x, res, text: res.body!.toString('utf8') };
  }

  it('payments: 202 pending → the worker uploads outside any transaction → a short signed link to the 13 §13 CSV', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    const b = await deliveredWith(t, 'DRV1', POS('AP4821'));
    ok(
      await reverse(t, 'SUP-R', a.paymentId, {
        reason: 'العميل دفع بالشبكة، جواله 0551234567',
        replacement: POS('RX1'),
      }),
    );

    const created = await createExport(t, 'SUP-R', { kind: 'payments', filters: { event_id: EVT_R2 } });
    expect(created.status).toBe(202);
    const x = created.body.data;
    expect(x).toMatchObject({
      kind: 'payments',
      filters: { event_id: EVT_R2 },
      status: 'pending',
      row_count: null,
      expires_at: null,
      download_url: null,
    });
    expect(
      await one(
        t.db,
        `SELECT type, dedupe_key, status FROM outbox_events WHERE type = 'job.export_generate'`,
      ),
    ).toEqual({ type: 'job.export_generate', dedupe_key: `export_generate:${x.id}`, status: 'pending' });
    const audit = await one(
      t.db,
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'export.create' AND entity_id = $1`,
      [x.id],
    );
    expect(audit).toMatchObject({
      actor_id: U['SUP-R'],
      metadata: { kind: 'payments', filters: { event_id: EVT_R2 } },
    });
    // pending: no link yet
    expect(ok(await getExport(t, 'SUP-R', x.id))).toMatchObject({ status: 'pending', download_url: null });

    const openTx = await generate();
    expect(openTx.length).toBeGreaterThanOrEqual(1); // the upload
    expect(openTx.every((n) => n === 0)).toBe(true);
    const row = await one(t.db, `SELECT * FROM exports WHERE id = $1`, [x.id]);
    expect(row).toMatchObject({
      status: 'ready',
      row_count: 3,
      storage_key: `exports/${ORG}/${x.id}.csv`,
      completed_at: t.clock.now(),
      expires_at: new Date(t.clock.now().getTime() + 24 * 3600_000),
      error: null,
    });
    expect(await auditCount(t.db, 'job.export_generate', x.id)).toBe(1);

    const { view, res, text } = await download('SUP-R', x.id);
    expect(view).toMatchObject({ row_count: 3, expires_at: row.expires_at.toISOString() });
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text.split('\r\n')[0]).toBe(`\uFEFF${PAYMENT_HEADER}`);
    const [header, ...data] = parseCsv(text);
    expect(header!.join(',')).toBe(PAYMENT_HEADER);
    const col = (r: string[], name: string) => r[header!.indexOf(name)];
    const payments = await rows(
      t.db,
      `SELECT * FROM payments WHERE event_id = $1 ORDER BY collected_at, id`,
      [EVT_R2],
    );
    expect(data.map((r) => col(r, 'payment_id'))).toEqual(payments.map((p) => p.id));
    for (const r of data) {
      const p = payments.find((x) => x.id === col(r, 'payment_id'))!;
      expect(col(r, 'amount_sar')).toBe('20.00');
      expect(col(r, 'event_date')).toBe('2026-10-27');
      expect(col(r, 'venue_code')).toBe('RMS');
      expect(col(r, 'collected_by_code')).toBe('D-0001');
      expect(col(r, 'collected_at_riyadh')).toBe(riyadh(p.collected_at));
      expect(col(r, 'method')).toBe(p.method);
      expect(col(r, 'status')).toBe(p.status);
    }
    const reversed = data.find((r) => col(r, 'payment_id') === a.paymentId)!;
    expect(col(reversed, 'status')).toBe('reversed');
    expect(col(reversed, 'reversed_by_code')).toBe('S-0001');
    expect(col(reversed, 'reversal_reason')).toContain('العميل دفع بالشبكة');
    expect(
      col(
        data.find((r) => col(r, 'payment_id') === b.paymentId)!,
        'pos_reference',
      ),
    ).toBe('AP4821');
    // no phone, plate, key position or code in a financial export (13 §13, PAY-TC-24)
    expect(text).not.toMatch(/0551234567|966551234567/);
    const tk = await one(t.db, `SELECT paper_serial, key_tag, plate_digits FROM tickets WHERE id = $1`, [
      a.ticketId,
    ]);
    for (const secret of [tk.paper_serial, tk.key_tag]) expect(text).not.toContain(secret);
    expect(
      await one(
        t.db,
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'export.create' AND entity_id = $1
            AND metadata->>'download_link_issued' = 'true'`,
        [x.id],
      ),
    ).toEqual({ n: 1 });

    // the link is short-lived (EXPORT_URL_TTL_S), the file itself 24 hours; then the retention job deletes it
    t.clock.advanceSeconds(t.env.EXPORT_URL_TTL_S + 1);
    expect(w.storage.download(view.download_url).status).toBe(403);
    t.clock.advanceSeconds(24 * 3600);
    expect(ok(await getExport(t, 'SUP-R', x.id))).toMatchObject({ status: 'expired', download_url: null });
    expect(w.storage.keys('exports/')).toEqual([row.storage_key]);
    await new RetentionPurger(t.db, t.clock, createLogger({ level: 'silent' })).run(ORG);
    expect(w.storage.keys('exports/')).toEqual([]);
    expect((await one(t.db, `SELECT status FROM exports WHERE id = $1`, [x.id])).status).toBe('expired');
  });

  it('scope: filters.venue_id outside → SCOPE_VENUE_DENIED, filters.event_id outside → 404, requester only, audit.read', async () => {
    expect(
      err(
        await createExport(t, 'SUP-R', { kind: 'tickets', filters: { venue_id: LYL } }),
        'SCOPE_VENUE_DENIED',
        403,
      ),
    ).toEqual({
      venue_id: LYL,
    });
    expect(
      err(
        await createExport(t, 'SUP-R', { kind: 'payments', filters: { event_id: EVT_L1 } }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'event' });
    expect(
      err(await createExport(t, 'SUP-R', { kind: 'audit', filters: {} }), 'PERMISSION_DENIED', 403),
    ).toEqual({
      permission: 'audit.read',
      reason: 'audit_read_required',
    });
    err(await createExport(t, 'DRV1', { kind: 'payments', filters: {} }), 'PERMISSION_DENIED', 403);
    for (const body of [
      { kind: 'bogus', filters: {} },
      { kind: 'payments', filters: { status: 'x' } },
      { kind: 'payments' },
      { kind: 'payments', filters: { from: '2026-10-28T00:00:00Z', to: '2026-10-27T00:00:00Z' } },
    ])
      err(await createExport(t, 'SUP-R', body), 'VALIDATION_FAILED', 422);
    expect(await rows(t.db, `SELECT id FROM exports`)).toEqual([]);

    const mine = await createExport(t, 'SUP-R', { kind: 'event_summary', filters: { venue_id: RMS } });
    expect(mine.status).toBe(202);
    // another supervisor, the owner: not their export (404, nothing leaks)
    for (const as of ['SUP-RL', 'OWN1'])
      expect(err(await getExport(t, as, mine.body.data.id), 'RESOURCE_NOT_FOUND', 404)).toEqual({
        resource: 'export',
      });
    err(await getExport(t, 'SUP-R', 'not-a-uuid'), 'RESOURCE_NOT_FOUND', 404);
    err(await getExport(t, 'SUP-R', '00000000-0000-4000-8000-0000deadbeef'), 'RESOURCE_NOT_FOUND', 404);
    // the administrator holds audit.read
    expect((await createExport(t, 'ADM1', { kind: 'audit', filters: {} })).status).toBe(202);
  });

  it('every kind builds; tickets mask the phone and carry no stub, key or spot; messages carry no recipient', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    await t.db.query(`UPDATE tickets SET customer_id = $2 WHERE id = $1`, [
      a.ticketId,
      SEED_IDS.customers.CUS1,
    ]);
    await t.db.query(
      `INSERT INTO whatsapp_messages (org_id, channel_id, direction, kind, purpose, status, recipient_wa_id, body_redacted,
                                      ticket_id, venue_id, event_id)
       VALUES ($1, $2, 'outbound', 'template', 'W-05', 'failed', '966551234567', 'رقم 0551234567', $3, $4, $5)`,
      [ORG, SEED_IDS.whatsappChannel, a.ticketId, RMS, EVT_R2],
    );
    const kinds = ['tickets', 'event_summary', 'drivers', 'messages'] as const;
    const ids: Record<string, string> = {};
    for (const kind of kinds)
      ids[kind] = ok(await createExport(t, 'SUP-R', { kind, filters: { event_id: EVT_R2 } }), 202).id;
    ids.audit = ok(await createExport(t, 'ADM1', { kind: 'audit', filters: { venue_id: RMS } }), 202).id;
    await generate();
    const files: Record<string, string> = {};
    for (const kind of kinds) files[kind] = (await download('SUP-R', ids[kind]!)).text;
    files.audit = (await download('ADM1', ids.audit!)).text;

    const tickets = parseCsv(files.tickets!);
    expect(tickets[0]).toContain('customer_phone_masked');
    expect(tickets[0]).not.toContain('paper_serial');
    expect(tickets).toHaveLength(2);
    const masked = tickets[1]![tickets[0]!.indexOf('customer_phone_masked')]!;
    expect(masked).not.toBe('');
    expect(masked).not.toContain('551234567');
    const tk = await one(t.db, `SELECT paper_serial, key_tag FROM tickets WHERE id = $1`, [a.ticketId]);
    for (const secret of [tk.paper_serial, tk.key_tag]) expect(files.tickets).not.toContain(secret);

    const summary = parseCsv(files.event_summary!);
    expect(summary[1]![summary[0]!.indexOf('event_id')]).toBe(EVT_R2);
    expect(summary[1]![summary[0]!.indexOf('cash_sar')]).toBe('20.00');
    const drivers = parseCsv(files.drivers!);
    expect(drivers.slice(1).map((r) => r[drivers[0]!.indexOf('employee_code')])).toEqual(['D-0001']);
    const messages = parseCsv(files.messages!);
    expect(messages).toHaveLength(2);
    expect(files.messages).not.toMatch(/966551234567|0551234567/);
    expect(parseCsv(files.audit!)[0]!.slice(0, 5)).toEqual([
      'id',
      'occurred_at_riyadh',
      'actor_type',
      'actor_code',
      'action',
    ]);
    for (const f of Object.values(files)) expect(f).not.toMatch(/966551234567/);
    expect(
      (await rows(t.db, `SELECT status FROM exports ORDER BY created_at`)).every((x) => x.status === 'ready'),
    ).toBe(true);
  });

  it('the requester’s scope at generation time: revoked before the job → failed (scope_revoked), audited', async () => {
    const x = ok(await createExport(t, 'SUP-R', { kind: 'tickets', filters: { venue_id: RMS } }), 202);
    await t.db.query(`UPDATE role_scopes SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1`, [
      U['SUP-R'],
      U.ADM1,
    ]);
    await generate();
    expect(await one(t.db, `SELECT status, error, storage_key FROM exports WHERE id = $1`, [x.id])).toEqual({
      status: 'failed',
      error: 'scope_revoked',
      storage_key: null,
    });
    expect(w.storage.keys('exports/')).toEqual([]);
    const a = await one(
      t.db,
      `SELECT actor_type, metadata FROM audit_log WHERE action = 'job.export_generate' AND entity_id = $1`,
      [x.id],
    );
    expect(a).toMatchObject({ actor_type: 'system', metadata: { status: 'failed', error: 'scope_revoked' } });
  });

  it('a storage outage is retried, then the export completes', async () => {
    const x = ok(await createExport(t, 'SUP-R', { kind: 'payments', filters: {} }), 202);
    w.storage.failNext('put', 'timeout');
    await generate();
    expect((await one(t.db, `SELECT status FROM exports WHERE id = $1`, [x.id])).status).toBe('running');
    const job = await one(
      t.db,
      `SELECT status, attempts FROM outbox_events WHERE type = 'job.export_generate'`,
    );
    expect(job.attempts).toBe(1);
    t.clock.advanceSeconds(600);
    await generate();
    expect(await one(t.db, `SELECT status, row_count FROM exports WHERE id = $1`, [x.id])).toEqual({
      status: 'ready',
      row_count: 0,
    });
  });
});
