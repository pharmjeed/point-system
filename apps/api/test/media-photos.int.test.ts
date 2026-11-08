import { createHash, randomUUID } from 'node:crypto';
import { InMemoryObjectStorage, OBJECT_STORAGE, isSanitized, sanitizeImage } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_IDS, createTestApp, newKey, type SeedUserKey, type TestApp } from './harness.js';

// PNT-027 — private inspection photos through the real routes (07 §2.2, 09 §3/§5.1/§6, 08 §4.14, DEC-36).
// Tickets are inserted with SQL (the intake routes belong to tickets-custody); the object storage is the
// in-memory private bucket the app selects when no S3 is configured.

/** 24×16 JPEG with EXIF Orientation 6, Make «FixtureCam», Model «GPS-1», a GPS position and an ICC profile. */
const JPEG_GPS = Buffer.from(
  '/9j/4QFYRXhpZgAASUkqAAgAAAAJAA8BAgALAAAAkAAAABABAgAGAAAAigAAABIBAwABAAAABgAAABoBBQABAAAAegAAABsBBQABAAAAggAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAnAAAACWIBAABAAAA6gAAAAAAAAA4YwAA6AMAADhjAADoAwAAR1BTLTEARml4dHVyZUNhbQAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAABgAAAADoAQAAQAAABAAAAAAAAAABAABAAIAAgAAAE4AAAACAAUAAwAAADgBAAADAAIAAgAAAEUAAAAEAAUAAwAAACABAAAAAAAALgAAAAEAAAAoAAAAAQAAALAEAABkAAAAGAAAAAEAAAAqAAAAAQAAABAOAABkAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwANCQoLCggNCwoLDg4NDxMgFRMSEhMnHB4XIC4pMTAuKS0sMzpKPjM2RjcsLUBXQUZMTlJTUjI+WmFaUGBKUVJP/9sAQwEODg4TERMmFRUmTzUtNU9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P/8AAEQgAEAAYAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAF/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAEBv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIYCFqAAH//Z',
  'base64',
);
/** A PNG (valid image, wrong type for a JPEG declaration). */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const FAKE_JPEG = Buffer.from('this file is called photo.jpg but it is only text');
const MAX_BYTES = 300_000;

const ORG = SEED_IDS.org;
const U = SEED_IDS.users;
const VENUES = SEED_IDS.venues;
const EVENTS = { RMS: SEED_IDS.events['EVT-R1'], LYL: SEED_IDS.events['EVT-L1'] } as const;
const POOLS = { RMS: SEED_IDS.pools['POOL-R'], LYL: SEED_IDS.pools['POOL-L'] } as const;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let t: TestApp;
let storage: InMemoryObjectStorage;
let clean: Buffer; // the sanitized JPEG_GPS
let displayNumber = 9000;

beforeAll(async () => {
  t = await createTestApp({ env: { MEDIA_MAX_BYTES: String(MAX_BYTES) } });
  storage = t.app.get(OBJECT_STORAGE);
  clean = (await sanitizeImage(JPEG_GPS, { declaredContentType: 'image/jpeg' })).data;
});
afterAll(() => t.close());

// ----- fixtures ------------------------------------------------------------------------------------------

type Status = 'received' | 'parking' | 'parked' | 'reparking' | 'delivered' | 'voided';

async function insertTicket(
  o: {
    status?: Status;
    by?: SeedUserKey;
    venue?: 'RMS' | 'LYL';
    inspection?: 'pending' | 'complete' | 'incomplete';
    submittedAt?: Date | null;
  } = {},
): Promise<string> {
  const venue = o.venue ?? 'RMS';
  const status = o.status ?? 'received';
  const by = U[o.by ?? 'DRV1'];
  const now = t.clock.now();
  const submitted =
    o.submittedAt !== undefined
      ? o.submittedAt
      : status === 'received'
        ? null
        : new Date(now.getTime() - 600_000);
  const onSpot = status === 'parked' || status === 'delivered';
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO tickets (org_id, venue_id, event_id, dispatch_pool_id, display_number, status, created_by,
                          vehicle_holder_type, vehicle_holder_id, submitted_at, inspection_status,
                          delivered_at, delivered_by, voided_at, voided_by, void_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      ORG,
      VENUES[venue],
      EVENTS[venue],
      POOLS[venue],
      ++displayNumber,
      status,
      by,
      status === 'parked' ? 'spot' : status === 'delivered' ? 'customer' : 'driver',
      onSpot ? null : by,
      submitted,
      o.inspection ?? (status === 'received' ? 'pending' : 'complete'),
      status === 'delivered' ? now : null,
      status === 'delivered' ? by : null,
      status === 'voided' ? now : null,
      status === 'voided' ? by : null,
      status === 'voided' ? 'test' : null,
    ],
  );
  return r.rows[0]!.id;
}

/** An `uploaded` photo planted directly (row + sanitized object), for tickets the upload route refuses. */
async function plantUploadedMedia(ticketId: string, by: SeedUserKey = 'DRV1'): Promise<string> {
  const id = randomUUID();
  const key = `org/${ORG}/tickets/${ticketId}/${id}.jpg`;
  storage.plant(key, clean, 'image/jpeg');
  await t.db.query(
    `INSERT INTO media_assets (id, org_id, ticket_id, kind, storage_key, content_type, byte_size, sha256, upload_status, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, 'photo_front', $4, 'image/jpeg', $5, $6, 'uploaded', $7, $8)`,
    [id, ORG, ticketId, key, clean.length, sha(clean), U[by], t.clock.now()],
  );
  return id;
}

const uploadBody = (o: Record<string, unknown> = {}) => ({
  kind: 'photo_front',
  content_type: 'image/jpeg',
  byte_size: JPEG_GPS.length,
  ...o,
});
const requestUpload = (ticketId: string, as: SeedUserKey, body: object = uploadBody(), key?: string | null) =>
  t.command('post', `/v1/tickets/${ticketId}/media`, { as, body, key });
const complete = (mediaId: string, as: SeedUserKey, body: object = {}, key?: string | null) =>
  t.command('post', `/v1/media/${mediaId}/complete`, { as, body, key });

/** request → PUT through the presigned URL → complete; returns the media id. */
async function uploadPhoto(
  ticketId: string,
  as: SeedUserKey = 'DRV1',
  body: object = uploadBody(),
): Promise<string> {
  const r = await requestUpload(ticketId, as, body);
  expect(r.status).toBe(201);
  expect(storage.upload(r.body.data.upload, JPEG_GPS).status).toBe(200);
  const c = await complete(r.body.data.media.id, as);
  expect(c.status).toBe(200);
  return r.body.data.media.id;
}

const mediaRow = async (id: string) =>
  (await t.db.query(`SELECT * FROM media_assets WHERE id = $1`, [id])).rows[0] as Record<string, any>;
const count = async (sql: string, params: unknown[]) =>
  (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).rows[0]!.n;

// ----- POST /v1/tickets/{ticketId}/media ------------------------------------------------------------------

describe('POST /v1/tickets/{ticketId}/media — upload request', () => {
  it('the creator in received gets a pending row and a presigned PUT bound to the type and the size', async () => {
    const ticketId = await insertTicket();
    const ioBefore = storage.operations.length;
    const r = await requestUpload(ticketId, 'DRV1', uploadBody({ captured_at: '2026-10-27T15:59:30.000Z' }));
    expect(r.status).toBe(201);
    const { media, upload } = r.body.data;
    expect(media).toMatchObject({
      ticket_id: ticketId,
      kind: 'photo_front',
      content_type: 'image/jpeg',
      byte_size: JPEG_GPS.length,
      upload_status: 'pending',
      captured_at: '2026-10-27T15:59:30.000Z',
      uploaded_at: null,
      uploaded_by: U.DRV1,
    });
    expect(Object.keys(media).sort()).toEqual(
      [
        'byte_size',
        'captured_at',
        'content_type',
        'id',
        'kind',
        'ticket_id',
        'upload_status',
        'uploaded_at',
        'uploaded_by',
      ].sort(),
    );
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    expect(upload.expires_at).toBe(new Date(t.clock.now().getTime() + 300_000).toISOString()); // MEDIA_UPLOAD_URL_TTL_S
    expect(storage.operations.length).toBe(ioBefore); // presigning only: no storage I/O in the transaction

    const row = await mediaRow(media.id);
    expect(row.upload_status).toBe('pending');
    expect(row.storage_key).toMatch(new RegExp(`^incoming/${ORG}/${ticketId}/${media.id}-[0-9a-f]{32}$`));
    expect(row.sha256).toBeNull();
    expect(
      await count(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'ticket.intake'`, [media.id]),
    ).toBe(1);
    const tk = (await t.db.query(`SELECT version FROM tickets WHERE id = $1`, [ticketId])).rows[0];
    expect(tk.version).toBe(1); // a photo does not change the ticket

    // the bucket enforces the signed headers: another type or another size is refused
    expect(storage.upload(upload, JPEG_GPS, { 'Content-Type': 'image/png' }).status).toBe(403);
    expect(storage.upload(upload, Buffer.concat([JPEG_GPS, Buffer.from([0])])).status).toBe(403);
    expect(storage.upload(upload, JPEG_GPS).status).toBe(200);
  });

  it('the creator may still upload while parking (to finish missing photos); a can_drive supervisor too', async () => {
    expect((await requestUpload(await insertTicket({ status: 'parking' }), 'DRV1')).status).toBe(201);
    expect((await requestUpload(await insertTicket({ by: 'SUP-RD' }), 'SUP-RD')).status).toBe(201);
  });

  it('PERMISSION_DENIED without ticket.intake, and for a driver who is not the creator', async () => {
    const ticketId = await insertTicket();
    for (const who of ['SUP-R', 'ADM1', 'OWN1'] as const) {
      const r = await requestUpload(ticketId, who);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({
        code: 'PERMISSION_DENIED',
        details: { permission: 'ticket.intake' },
      });
    }
    const r = await requestUpload(ticketId, 'DRV2');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('TICKET_NOT_FOUND for an unknown, malformed, out-of-scope or (for a driver) closed ticket', async () => {
    const lyl = await insertTicket({ venue: 'LYL', by: 'DRV7' });
    const delivered = await insertTicket({ status: 'delivered' });
    const voided = await insertTicket({ status: 'voided' });
    for (const id of [randomUUID(), 'not-a-uuid', lyl, delivered, voided]) {
      const r = await requestUpload(id, 'DRV1');
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('TICKET_NOT_FOUND');
    }
  });

  it('INVALID_STATE_TRANSITION once the ticket left received/parking', async () => {
    const ticketId = await insertTicket({ status: 'parked' });
    const r = await requestUpload(ticketId, 'DRV1');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: {
        entity_type: 'ticket',
        entity_id: ticketId,
        current_status: 'parked',
        allowed_from: ['received', 'parking'],
      },
    });
  });

  it('input checks: VALIDATION_FAILED, MEDIA_TYPE_UNSUPPORTED (allowed_types), MEDIA_TOO_LARGE (max_bytes)', async () => {
    const ticketId = await insertTicket();
    for (const body of [
      { content_type: 'image/jpeg', byte_size: 10 },
      uploadBody({ kind: 'photo_roof' }),
      uploadBody({ byte_size: 0 }),
      uploadBody({ byte_size: 1.5 }),
      uploadBody({ sha256: 'ABC' }),
      uploadBody({ captured_at: 'yesterday' }),
      uploadBody({ storage_key: 'org/x' }),
    ]) {
      const r = await requestUpload(ticketId, 'DRV1', body);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
      expect(r.body.error.details.fields.length).toBeGreaterThan(0);
    }
    const gif = await requestUpload(ticketId, 'DRV1', uploadBody({ content_type: 'image/gif' }));
    expect(gif.status).toBe(415);
    expect(gif.body.error).toMatchObject({
      code: 'MEDIA_TYPE_UNSUPPORTED',
      details: { allowed_types: ['image/jpeg', 'image/webp', 'image/heic', 'image/png'] },
    });
    // media types are case-insensitive
    expect((await requestUpload(ticketId, 'DRV1', uploadBody({ content_type: 'IMAGE/JPEG' }))).status).toBe(
      201,
    );
    const big = await requestUpload(ticketId, 'DRV1', uploadBody({ byte_size: MAX_BYTES + 1 }));
    expect(big.status).toBe(413);
    expect(big.body.error).toMatchObject({ code: 'MEDIA_TOO_LARGE', details: { max_bytes: MAX_BYTES } });
    expect((await requestUpload(ticketId, 'DRV1', uploadBody({ byte_size: MAX_BYTES }))).status).toBe(201);
  });

  it('idempotency, CSRF and session: 428 without a key, replay, key reuse, 403 csrf, 401', async () => {
    const ticketId = await insertTicket();
    const none = await requestUpload(ticketId, 'DRV1', uploadBody(), null);
    expect(none.status).toBe(428);
    expect(none.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = newKey();
    const first = await requestUpload(ticketId, 'DRV1', uploadBody(), key);
    const again = await requestUpload(ticketId, 'DRV1', uploadBody(), key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data).toEqual(first.body.data);
    expect(await count(`SELECT 1 FROM media_assets WHERE ticket_id = $1`, [ticketId])).toBe(1);
    const reused = await requestUpload(ticketId, 'DRV1', uploadBody({ kind: 'photo_rear' }), key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const path = `/v1/tickets/${ticketId}/media`;
    const csrf = await t
      .http()
      .post(path)
      .set('Cookie', await t.sessionFor('DRV1'))
      .set('Idempotency-Key', newKey())
      .send(uploadBody());
    expect(csrf.status).toBe(403);
    expect(csrf.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'csrf' } });
    const anon = await t.http().post(path).set(CSRF).set('Idempotency-Key', newKey()).send(uploadBody());
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('AUTH_UNAUTHENTICATED');
  });

  it('inspection.max_extra_photos limits the non-required kinds; expired pending requests free their slot', async () => {
    const prev = (await t.db.query(`SELECT settings FROM venues WHERE id = $1`, [VENUES.RMS])).rows[0]
      .settings;
    await t.db.query(
      `UPDATE venues SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{inspection}', $2::jsonb) WHERE id = $1`,
      [VENUES.RMS, JSON.stringify({ max_extra_photos: 2 })],
    );
    try {
      const ticketId = await insertTicket();
      expect((await requestUpload(ticketId, 'DRV1', uploadBody({ kind: 'photo_extra' }))).status).toBe(201);
      expect((await requestUpload(ticketId, 'DRV1', uploadBody({ kind: 'photo_damage' }))).status).toBe(201);
      const third = await requestUpload(ticketId, 'DRV1', uploadBody({ kind: 'photo_extra' }));
      expect(third.status).toBe(409);
      expect(third.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { reason: 'max_extra_photos', max_extra_photos: 2, entity_id: ticketId },
      });
      // required kinds (retakes) are not limited
      expect((await requestUpload(ticketId, 'DRV1', uploadBody({ kind: 'photo_front' }))).status).toBe(201);
      expect((await requestUpload(ticketId, 'DRV1', uploadBody({ kind: 'photo_front' }))).status).toBe(201);
      // the two pending extras can no longer be uploaded once their URL expired
      t.clock.advanceSeconds(301);
      expect((await requestUpload(ticketId, 'DRV1', uploadBody({ kind: 'photo_extra' }))).status).toBe(201);
    } finally {
      await t.db.query(`UPDATE venues SET settings = $2 WHERE id = $1`, [VENUES.RMS, prev]);
    }
  });
});

// ----- POST /v1/media/{mediaId}/complete -------------------------------------------------------------------

describe('POST /v1/media/{mediaId}/complete — verification and EXIF stripping', () => {
  it('stores a sanitized copy (no EXIF/GPS) with its new size and sha256, deletes the original, writes the timeline', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1', uploadBody({ sha256: sha(JPEG_GPS) }));
    const mediaId: string = r.body.data.media.id;
    const uploadKey: string = (await mediaRow(mediaId)).storage_key;
    expect(storage.upload(r.body.data.upload, JPEG_GPS).status).toBe(200);

    // no storage call may run while a transaction is open (ENGINEERING §2)
    const openTx: number[] = [];
    storage.beforeOperation = async () => {
      const q = await t.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
      );
      openTx.push(q.rows[0]!.n);
    };
    let c;
    try {
      c = await complete(mediaId, 'DRV1', { sha256: sha(JPEG_GPS) });
    } finally {
      storage.beforeOperation = null;
    }
    expect(openTx.length).toBeGreaterThanOrEqual(4); // head, get, put, delete
    expect(openTx.every((n) => n === 0)).toBe(true);

    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({
      id: mediaId,
      upload_status: 'uploaded',
      content_type: 'image/jpeg',
      uploaded_at: t.clock.now().toISOString(),
      uploaded_by: U.DRV1,
    });
    const row = await mediaRow(mediaId);
    expect(row.storage_key).toBe(`org/${ORG}/tickets/${ticketId}/${mediaId}.jpg`); // 09 §6.1
    const stored = storage.peek(row.storage_key)!;
    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.cacheControl).toBe('private, no-store');
    // DEC-36: the row describes the sanitized bytes, not the upload
    expect(row.byte_size).toBe(stored.body.length);
    expect(row.sha256).toBe(sha(stored.body));
    expect(row.sha256).not.toBe(sha(JPEG_GPS));
    expect(c.body.data.byte_size).toBe(stored.body.length);
    // EXIF/GPS gone; the unsanitized original does not survive
    expect(JPEG_GPS.includes(Buffer.from('FixtureCam'))).toBe(true);
    expect(stored.body.includes(Buffer.from('FixtureCam'))).toBe(false);
    expect(await isSanitized(JPEG_GPS)).toBe(false);
    expect(await isSanitized(stored.body)).toBe(true);
    expect(storage.peek(uploadKey)).toBeUndefined();

    const ev = await t.db.query(`SELECT * FROM ticket_events WHERE ticket_id = $1`, [ticketId]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({
      type: 'ticket.photo_uploaded',
      actor_type: 'user',
      actor_id: U.DRV1,
      ticket_version: 1,
    });
    expect(ev.rows[0].data).toMatchObject({ media_id: mediaId, kind: 'photo_front' });
    const audit = await t.db.query(
      `SELECT * FROM audit_log WHERE entity_id = $1 AND metadata->>'command' = 'POST /v1/media/{mediaId}/complete'`,
      [mediaId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after).toMatchObject({ upload_status: 'uploaded', sha256: row.sha256 });
    expect(audit.rows[0].metadata).toMatchObject({ original_sha256: sha(JPEG_GPS), metadata_stripped: true });
  });

  it('calling complete twice is safe: same key replays, a new key answers the uploaded photo, no second entry', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const mediaId: string = r.body.data.media.id;
    storage.upload(r.body.data.upload, JPEG_GPS);
    const key = newKey();
    const first = await complete(mediaId, 'DRV1', {}, key);
    expect(first.status).toBe(200);
    const stored = Buffer.from(storage.peek((await mediaRow(mediaId)).storage_key)!.body);

    const replay = await complete(mediaId, 'DRV1', {}, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(first.body.data);

    const ioBefore = storage.operations.length;
    const second = await complete(mediaId, 'DRV1');
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(storage.operations.length).toBe(ioBefore); // an uploaded photo needs no storage work
    expect(await count(`SELECT 1 FROM ticket_events WHERE ticket_id = $1`, [ticketId])).toBe(1);
    expect(storage.peek((await mediaRow(mediaId)).storage_key)!.body.equals(stored)).toBe(true);
    const noop = await t.db.query(
      `SELECT metadata FROM audit_log WHERE entity_id = $1 AND metadata->>'result' = 'already_uploaded'`,
      [mediaId],
    );
    expect(noop.rows).toHaveLength(1);
  });

  it('two concurrent completions converge on one sanitized object and one timeline entry', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const mediaId: string = r.body.data.media.id;
    storage.upload(r.body.data.upload, JPEG_GPS);
    const [a, b] = await Promise.all([complete(mediaId, 'DRV1'), complete(mediaId, 'DRV1')]);
    // the loser may find the original already gone and resume from the sanitized copy
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.upload_status).toBe('uploaded');
    expect(b.body.data).toEqual(a.body.data);
    const row = await mediaRow(mediaId);
    expect(row.sha256).toBe(sha(storage.peek(row.storage_key)!.body));
    expect(
      await count(`SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND type = 'ticket.photo_uploaded'`, [
        ticketId,
      ]),
    ).toBe(1);
    expect(storage.keys(`incoming/${ORG}/${ticketId}/`)).toEqual([]);
  });

  it('MEDIA_UPLOAD_INCOMPLETE before the upload, then the same media completes once uploaded', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const mediaId: string = r.body.data.media.id;
    const early = await complete(mediaId, 'DRV1');
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({
      code: 'MEDIA_UPLOAD_INCOMPLETE',
      retryable: false,
      details: { media_id: mediaId, upload_status: 'pending' },
    });
    expect((await mediaRow(mediaId)).upload_status).toBe('pending');
    expect(storage.upload(r.body.data.upload, JPEG_GPS).status).toBe(200);
    expect((await complete(mediaId, 'DRV1')).status).toBe(200);
  });

  it('MEDIA_UPLOAD_INCOMPLETE when the object does not match the declared size or sha256 — and it is discarded', async () => {
    const ticketId = await insertTicket();
    // declared sha256 (request) ≠ uploaded bytes
    const a = await requestUpload(ticketId, 'DRV1', uploadBody({ sha256: 'a'.repeat(64) }));
    storage.upload(a.body.data.upload, JPEG_GPS);
    const ra = await complete(a.body.data.media.id, 'DRV1');
    expect(ra.status).toBe(409);
    expect(ra.body.error.code).toBe('MEDIA_UPLOAD_INCOMPLETE');
    expect(storage.peek((await mediaRow(a.body.data.media.id)).storage_key)).toBeUndefined();

    // sha256 sent with complete ≠ uploaded bytes
    const b = await requestUpload(ticketId, 'DRV1');
    storage.upload(b.body.data.upload, JPEG_GPS);
    const rb = await complete(b.body.data.media.id, 'DRV1', { sha256: 'b'.repeat(64) });
    expect(rb.status).toBe(409);
    expect(rb.body.error.code).toBe('MEDIA_UPLOAD_INCOMPLETE');

    // an object of another size (written around the presigned URL)
    const c = await requestUpload(ticketId, 'DRV1');
    const key = (await mediaRow(c.body.data.media.id)).storage_key;
    storage.plant(key, JPEG_GPS.subarray(0, 500), 'image/jpeg');
    const rc = await complete(c.body.data.media.id, 'DRV1');
    expect(rc.status).toBe(409);
    expect(rc.body.error.code).toBe('MEDIA_UPLOAD_INCOMPLETE');
    expect(storage.peek(key)).toBeUndefined();

    // a failed or deleted photo cannot be completed
    const d = await requestUpload(ticketId, 'DRV1');
    await t.db.query(`UPDATE media_assets SET upload_status = 'failed' WHERE id = $1`, [
      d.body.data.media.id,
    ]);
    const rd = await complete(d.body.data.media.id, 'DRV1');
    expect(rd.status).toBe(409);
    expect(rd.body.error.details).toEqual({ media_id: d.body.data.media.id, upload_status: 'failed' });
    // a malformed body is a validation error
    const e = await complete(d.body.data.media.id, 'DRV1', { sha256: 'xyz' });
    expect(e.status).toBe(422);
    expect(e.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('MEDIA_TYPE_UNSUPPORTED for a fake image (TC-071) or another format than declared; the bytes are discarded', async () => {
    const ticketId = await insertTicket();
    for (const bytes of [FAKE_JPEG, PNG_1PX]) {
      const r = await requestUpload(ticketId, 'DRV1', uploadBody({ byte_size: bytes.length }));
      expect(storage.upload(r.body.data.upload, bytes).status).toBe(200); // the bucket cannot tell
      const key = (await mediaRow(r.body.data.media.id)).storage_key;
      const c = await complete(r.body.data.media.id, 'DRV1');
      expect(c.status).toBe(415);
      expect(c.body.error).toMatchObject({
        code: 'MEDIA_TYPE_UNSUPPORTED',
        details: { allowed_types: expect.any(Array) },
      });
      expect(storage.peek(key)).toBeUndefined();
      expect((await mediaRow(r.body.data.media.id)).upload_status).toBe('pending');
    }
  });

  it('MEDIA_TOO_LARGE when the stored object is above MEDIA_MAX_BYTES', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const key = (await mediaRow(r.body.data.media.id)).storage_key;
    storage.plant(key, Buffer.alloc(MAX_BYTES + 1, 1), 'image/jpeg');
    const c = await complete(r.body.data.media.id, 'DRV1');
    expect(c.status).toBe(413);
    expect(c.body.error).toMatchObject({ code: 'MEDIA_TOO_LARGE', details: { max_bytes: MAX_BYTES } });
    expect(storage.peek(key)).toBeUndefined();
  });

  it('RESOURCE_NOT_FOUND unless the caller uploaded it and is in scope; PERMISSION_DENIED without ticket.intake', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const mediaId: string = r.body.data.media.id;
    storage.upload(r.body.data.upload, JPEG_GPS);
    for (const [id, who] of [
      [randomUUID(), 'DRV1'],
      ['nope', 'DRV1'],
      [mediaId, 'DRV2'], // same venue, not the uploader
      [mediaId, 'DRV7'], // other venue
      [mediaId, 'SUP-RD'], // can_drive supervisor in scope, not the uploader
    ] as const) {
      const c = await complete(id, who);
      expect(c.status).toBe(404);
      expect(c.body.error).toMatchObject({ code: 'RESOURCE_NOT_FOUND', details: { resource: 'media' } });
    }
    const sup = await complete(mediaId, 'SUP-R');
    expect(sup.status).toBe(403);
    expect(sup.body.error.code).toBe('PERMISSION_DENIED');
    expect((await complete(mediaId, 'DRV1', {}, null)).status).toBe(428);
    expect((await complete(mediaId, 'DRV1')).status).toBe(200);
  });

  it('DEPENDENCY_TIMEOUT when the storage does not answer: not stored with the key, the same key then succeeds', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const mediaId: string = r.body.data.media.id;
    storage.upload(r.body.data.upload, JPEG_GPS);
    const key = newKey();
    storage.failNext('get', 'timeout');
    const c = await complete(mediaId, 'DRV1', {}, key);
    expect(c.status).toBe(504);
    expect(c.body.error).toMatchObject({
      code: 'DEPENDENCY_TIMEOUT',
      retryable: true,
      details: { dependency: 'object_storage' },
    });
    expect(await count(`SELECT 1 FROM idempotency_keys WHERE key = $1`, [key])).toBe(0);
    expect((await mediaRow(mediaId)).upload_status).toBe('pending');
    const retry = await complete(mediaId, 'DRV1', {}, key);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });

  it('a completion interrupted after the original was deleted resumes from the sanitized copy', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const mediaId: string = r.body.data.media.id;
    // state left by a storage phase whose transaction never committed: sanitized copy stored, original gone
    storage.plant(`org/${ORG}/tickets/${ticketId}/${mediaId}.jpg`, clean, 'image/jpeg');
    const c = await complete(mediaId, 'DRV1');
    expect(c.status).toBe(200);
    const row = await mediaRow(mediaId);
    expect(row).toMatchObject({ upload_status: 'uploaded', byte_size: clean.length, sha256: sha(clean) });
    const audit = await t.db.query(
      `SELECT metadata FROM audit_log WHERE entity_id = $1 AND metadata->>'resumed' = 'true'`,
      [mediaId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('late photos complete an incomplete intake inspection (11 §6.3): inspection_status, version, event', async () => {
    const submittedAt = new Date(t.clock.now().getTime() - 120_000);
    const ticketId = await insertTicket({ status: 'parking', inspection: 'incomplete', submittedAt });
    await t.db.query(
      `INSERT INTO vehicle_inspections (org_id, ticket_id, kind, captured_by, required_photos_ok) VALUES ($1, $2, 'intake', $3, false)`,
      [ORG, ticketId, U.DRV1],
    );
    const before = new Date(submittedAt.getTime() - 60_000).toISOString();
    const after = new Date(submittedAt.getTime() + 60_000).toISOString();
    for (const kind of ['photo_front', 'photo_rear', 'photo_left']) {
      await uploadPhoto(ticketId, 'DRV1', uploadBody({ kind, captured_at: before }));
    }
    // taken after the submission: does not complete the intake inspection
    await uploadPhoto(ticketId, 'DRV1', uploadBody({ kind: 'photo_right', captured_at: after }));
    let tk = (await t.db.query(`SELECT inspection_status, version FROM tickets WHERE id = $1`, [ticketId]))
      .rows[0];
    expect(tk).toMatchObject({ inspection_status: 'incomplete', version: 1 });

    const last = await uploadPhoto(
      ticketId,
      'DRV1',
      uploadBody({ kind: 'photo_right', captured_at: before }),
    );
    tk = (await t.db.query(`SELECT inspection_status, version FROM tickets WHERE id = $1`, [ticketId]))
      .rows[0];
    expect(tk).toMatchObject({ inspection_status: 'complete', version: 2 });
    const ev = await t.db.query(
      `SELECT * FROM ticket_events WHERE ticket_id = $1 AND type = 'ticket.inspection_completed'`,
      [ticketId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ ticket_version: 2, data: { media_id: last } });
    const ob = await t.db.query(
      `SELECT * FROM outbox_events WHERE type = 'ticket.inspection_completed' AND aggregate_id = $1`,
      [ticketId],
    );
    expect(ob.rows).toHaveLength(1);
    expect(ob.rows[0]).toMatchObject({ aggregate_type: 'ticket', aggregate_version: 2 });
    expect(ob.rows[0].payload.payload).toEqual({
      ticket: { ticket_id: ticketId, display_number: expect.any(Number), ticket_version: 2 },
      media_id: last,
    });
    const insp = (
      await t.db.query(`SELECT required_photos_ok FROM vehicle_inspections WHERE ticket_id = $1`, [ticketId])
    ).rows[0];
    expect(insp.required_photos_ok).toBe(true);
  });
});

// ----- GET /v1/media/{mediaId}/url -------------------------------------------------------------------------

describe('GET /v1/media/{mediaId}/url — short-lived signed read link', () => {
  it('the creator during intake gets a 300 s link serving the sanitized photo; it expires; no anonymous read', async () => {
    const ticketId = await insertTicket();
    const mediaId = await uploadPhoto(ticketId);
    const r = await t.get(`/v1/media/${mediaId}/url`, 'DRV1');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(Object.keys(r.body.data).sort()).toEqual(['expires_at', 'url']);
    expect(r.body.data.expires_at).toBe(
      new Date(Math.floor(t.clock.now().getTime() / 1000) * 1000 + 300_000).toISOString(),
    );

    const ok = storage.download(r.body.data.url);
    expect(ok.status).toBe(200);
    expect(ok.headers).toMatchObject({ 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' });
    expect(sha(ok.body!)).toBe((await mediaRow(mediaId)).sha256);
    expect(await isSanitized(ok.body!)).toBe(true);

    // private bucket: the same object without a signature is refused
    expect(storage.download(r.body.data.url.split('?')[0]).status).toBe(403);
    t.clock.advanceSeconds(299);
    expect(storage.download(r.body.data.url).status).toBe(200);
    t.clock.advanceSeconds(1);
    expect(storage.download(r.body.data.url)).toMatchObject({ status: 403, message: 'Request has expired' });
  });

  it('access follows ticket.read_full: staff in scope and the open-task assignee; anyone else gets RESOURCE_NOT_FOUND', async () => {
    // reparking ticket created by DRV3, its open repark task assigned to DRV2
    const reparking = await insertTicket({ status: 'reparking', by: 'DRV3' });
    await t.db.query(
      `INSERT INTO tasks (org_id, venue_id, dispatch_pool_id, event_id, ticket_id, type, status, priority_at, assignee_id, accepted_at, started_at)
       VALUES ($1, $2, $3, $4, $5, 'repark', 'in_progress', $6, $7, $6, $6)`,
      [ORG, VENUES.RMS, POOLS.RMS, EVENTS.RMS, reparking, t.clock.now(), U.DRV2],
    );
    const onReparking = await plantUploadedMedia(reparking, 'DRV3');
    const onParked = await plantUploadedMedia(await insertTicket({ status: 'parked' }), 'DRV1');
    const onDelivered = await plantUploadedMedia(await insertTicket({ status: 'delivered' }), 'DRV1');
    const onLyl = await plantUploadedMedia(await insertTicket({ venue: 'LYL', by: 'DRV7' }), 'DRV7');

    const status = async (id: string, who: SeedUserKey) => {
      const r = await t.get(`/v1/media/${id}/url`, who);
      if (r.status === 404)
        expect(r.body.error).toMatchObject({ code: 'RESOURCE_NOT_FOUND', details: { resource: 'media' } });
      return r.status;
    };
    expect(await status(onReparking, 'DRV2')).toBe(200); // assignee of the open task
    expect(await status(onReparking, 'DRV3')).toBe(404); // creator, but the intake is over
    expect(await status(onReparking, 'DRV4')).toBe(404); // neither
    for (const who of ['SUP-R', 'SUP-RL', 'SUP-RD', 'ADM1', 'OWN1'] as const) {
      expect(await status(onReparking, who)).toBe(200);
      expect(await status(onDelivered, who)).toBe(200);
    }
    expect(await status(onParked, 'DRV1')).toBe(404);
    expect(await status(onDelivered, 'DRV1')).toBe(404);
    expect(await status(onLyl, 'DRV7')).toBe(200); // creator during received
    expect(await status(onLyl, 'SUP-RL')).toBe(200);
    expect(await status(onLyl, 'SUP-R')).toBe(404); // out of scope
    expect(await status(onLyl, 'DRV1')).toBe(404);
    expect(await status(randomUUID(), 'OWN1')).toBe(404);
    expect(await status('nope', 'OWN1')).toBe(404);
  });

  it('MEDIA_UPLOAD_INCOMPLETE for a photo not uploaded yet — only after the access check (non-disclosure)', async () => {
    const ticketId = await insertTicket();
    const r = await requestUpload(ticketId, 'DRV1');
    const mediaId: string = r.body.data.media.id;
    const mine = await t.get(`/v1/media/${mediaId}/url`, 'DRV1');
    expect(mine.status).toBe(409);
    expect(mine.body.error).toMatchObject({
      code: 'MEDIA_UPLOAD_INCOMPLETE',
      details: { media_id: mediaId, upload_status: 'pending' },
    });
    expect((await t.get(`/v1/media/${mediaId}/url`, 'DRV4')).status).toBe(404);
    expect((await t.http().get(`/v1/media/${mediaId}/url`)).status).toBe(401);
  });
});
