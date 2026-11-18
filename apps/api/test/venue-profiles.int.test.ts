import { randomUUID } from 'node:crypto';
import {
  InMemoryObjectStorage,
  OBJECT_STORAGE,
  getPublicLocation,
  isSanitized,
  listPublicLocations,
  sha256Hex,
} from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';
import { operator, seedOperatorB } from './operators-fixture.js';

/**
 * V2-004 — the venue public profile (O-04 / P-04, DEC-490 … DEC-494): the operator saves a draft with photos and
 * submits it; the platform approves, sends back with a reason, hides and unhides, and sets the prices; the public
 * read model lists only approved profiles of active operators and venues, with presigned photo links.
 */

/** 24×16 JPEG with EXIF (orientation, camera, GPS) — the media suite's fixture. */
const JPEG_GPS = Buffer.from(
  '/9j/4QFYRXhpZgAASUkqAAgAAAAJAA8BAgALAAAAkAAAABABAgAGAAAAigAAABIBAwABAAAABgAAABoBBQABAAAAegAAABsBBQABAAAAggAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAnAAAACWIBAABAAAA6gAAAAAAAAA4YwAA6AMAADhjAADoAwAAR1BTLTEARml4dHVyZUNhbQAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAABgAAAADoAQAAQAAABAAAAAAAAAABAABAAIAAgAAAE4AAAACAAUAAwAAADgBAAADAAIAAgAAAEUAAAAEAAUAAwAAACABAAAAAAAALgAAAAEAAAAoAAAAAQAAALAEAABkAAAAGAAAAAEAAAAqAAAAAQAAABAOAABkAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwANCQoLCggNCwoLDg4NDxMgFRMSEhMnHB4XIC4pMTAuKS0sMzpKPjM2RjcsLUBXQUZMTlJTUjI+WmFaUGBKUVJP/9sAQwEODg4TERMmFRUmTzUtNU9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P/8AAEQgAEAAYAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAF/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAEBv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIYCFqAAH//Z',
  'base64',
);
const FAKE_JPEG = Buffer.from('this file is called photo.jpg but it is only text');

const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const LYL = SEED_IDS.venues.LYL;
const B = operator('B');

const HOURS = {
  always_open: false,
  days: {
    sun: [{ open: '08:00', close: '22:00' }],
    thu: [
      { open: '16:00', close: '23:59' },
      { open: '08:00', close: '12:00' },
    ],
    fri: [{ open: '20:00', close: '02:00' }], // past midnight into Saturday
  },
};
const PROFILE = {
  category: 'mall',
  address: 'طريق الملك فهد، العليا',
  city: 'الرياض',
  lat: 24.7136,
  lng: 46.6753,
  opening_hours: HOURS,
  photo_ids: [] as string[],
};

let t: TestApp;
let storage: InMemoryObjectStorage;
const platform: Record<'owner' | 'admin' | 'finance' | 'support', { id: string; cookie: string }> =
  {} as never;

const path = (venue: string, tail = '') => `/v1/venues/${venue}/public-profile${tail}`;

async function platformAccount(role: keyof typeof platform, n: number) {
  const u = await t.db.query<{ id: string }>(
    `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
     VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
    [`+96655111930${n}`, `منصة ${role}`, `platform_${role}`],
  );
  const token = `venue-profiles-platform-session-${role}-0001`;
  await t.db.query(
    `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '48 hours')`,
    [u.rows[0]!.id, sha256Hex(token), t.clock.now()],
  );
  platform[role] = { id: u.rows[0]!.id, cookie: `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${token}` };
}

const pcmd = (
  role: keyof typeof platform,
  method: 'post' | 'put',
  p: string,
  body: object,
  key: string | null = newKey(),
) => {
  let r = t.http()[method](p).set(CSRF).set('Cookie', platform[role].cookie);
  if (key) r = r.set('Idempotency-Key', key);
  return r.send(body);
};
const pget = (role: keyof typeof platform, p: string) => t.http().get(p).set('Cookie', platform[role].cookie);

const signer = () => ({ storage, now: t.clock.now(), ttlS: t.env.MEDIA_READ_URL_TTL_S });

async function uploadPhoto(venue: string, body: Buffer = JPEG_GPS, as = 'OWN1'): Promise<string> {
  const res = await t.command('post', path(venue, '/photos'), {
    as,
    body: { content_type: 'image/jpeg', byte_size: body.length },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(storage.upload(res.body.data.upload, body).status).toBe(200);
  return res.body.data.photo_id;
}

async function profile(venue = RMS) {
  const r = await t.get(path(venue), 'OWN1');
  expect(r.status).toBe(200);
  return r.body.data;
}

beforeAll(async () => {
  t = await createTestApp();
  storage = t.app.get(OBJECT_STORAGE);
  await seedOperatorB(t.db);
  await platformAccount('owner', 1);
  await platformAccount('admin', 2);
  await platformAccount('finance', 3);
  await platformAccount('support', 4);
});
afterAll(async () => t?.close());

describe('operator side (O-04, S-13)', () => {
  it('a venue without a profile reads as the empty draft-to-be (status null, version 0)', async () => {
    const p = await profile();
    expect(p).toMatchObject({
      venue_id: RMS,
      venue: { code: 'RMS', status: 'active' },
      status: null,
      category: null,
      photos: [],
      version: 0,
      review_note: null,
      opening_hours: { always_open: false, days: {} },
      subscriptions_enabled: false,
      pay_per_visit_halalas: null,
    });
  });

  it('the opening hours and the coordinates are validated (overlap, empty interval, pair, unknown day)', async () => {
    const bad = async (patch: object) =>
      t.command('put', path(RMS), { as: 'OWN1', body: { expected_version: 0, ...PROFILE, ...patch } });
    const overlap = await bad({
      opening_hours: {
        always_open: false,
        days: {
          sun: [
            { open: '08:00', close: '12:00' },
            { open: '11:00', close: '14:00' },
          ],
        },
      },
    });
    expect(overlap.status).toBe(422);
    expect(overlap.body.error.details.fields[0]).toMatchObject({
      field: 'opening_hours.days.sun.1',
      message: 'overlapping_intervals',
    });
    const empty = await bad({
      opening_hours: { always_open: false, days: { mon: [{ open: '10:00', close: '10:00' }] } },
    });
    expect(empty.body.error.details.fields[0].message).toBe('empty_interval');
    expect((await bad({ lng: null })).body.error.details.fields[0]).toMatchObject({
      field: 'lng',
      message: 'coordinates_pair',
    });
    expect(
      (await bad({ opening_hours: { always_open: false, days: { someday: [] } } })).body.error.code,
    ).toBe('VALIDATION_FAILED');
    expect((await bad({ expected_version: 1 })).body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { entity: 'venue_public_profile', current_version: 0 },
    });
  });

  it('a photo is uploaded to incoming/, sanitized (no EXIF/GPS) by the PUT and attached; the draft is created', async () => {
    const photoId = await uploadPhoto(RMS);
    expect(storage.keys(`incoming/${ORG}/venues/${RMS}/`)).toEqual([
      `incoming/${ORG}/venues/${RMS}/${photoId}`,
    ]);
    const res = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: { expected_version: 0, ...PROFILE, photo_ids: [photoId] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.data).toMatchObject({
      status: 'draft',
      category: 'mall',
      address: PROFILE.address,
      city: 'الرياض',
      lat: 24.7136,
      lng: 46.6753,
      version: 1,
      photos: [{ id: photoId }],
    });
    // the stored hours are canonical: Thursday's intervals sorted by opening time
    expect(res.body.data.opening_hours.days.thu.map((i: { open: string }) => i.open)).toEqual([
      '08:00',
      '16:00',
    ]);
    // the original is gone, the sanitized copy carries no metadata, the link is presigned and short-lived
    expect(storage.keys(`incoming/${ORG}/venues/${RMS}/`)).toEqual([]);
    const stored = storage.peek(`org/${ORG}/venues/${RMS}/photos/${photoId}`)!;
    expect(await isSanitized(stored.body)).toBe(true);
    const url = res.body.data.photos[0].url as string;
    expect(
      new Date(res.body.data.photos[0].expires_at).getTime() - t.clock.now().getTime(),
    ).toBeLessThanOrEqual(300_000);
    expect(storage.download(url).status).toBe(200);
    expect(
      storage.handleHttp(
        'GET',
        `${storage.baseUrl}/${storage.bucket}/org/${ORG}/venues/${RMS}/photos/${photoId}`,
      ).status,
    ).toBe(403);
    // the address and the city are the venue's own (DEC-491)
    const v = (await t.db.query(`SELECT address, city FROM venues WHERE id = $1`, [RMS])).rows[0];
    expect(v).toEqual({ address: PROFILE.address, city: 'الرياض' });
    // exactly one audit row for the command, with the reviewed fields and no URL
    const a = await t.db.query(
      `SELECT action, actor_id, after, metadata FROM audit_log
        WHERE entity_type = 'venue_public_profile' AND entity_id = $1 AND metadata->>'command' = 'PUT /v1/venues/{venueId}/public-profile'`,
      [RMS],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ action: 'venue.manage', actor_id: SEED_IDS.users.OWN1 });
    expect(JSON.stringify(a.rows[0].after)).not.toContain('http');
  });

  it('a photo never uploaded, or not an image, is refused before anything is written', async () => {
    const p = await profile();
    const never = randomUUID();
    const r1 = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: { expected_version: p.version, ...PROFILE, photo_ids: [never] },
    });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatchObject({ code: 'MEDIA_UPLOAD_INCOMPLETE', details: { media_id: never } });
    const fake = await uploadPhoto(RMS, FAKE_JPEG);
    const r2 = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: { expected_version: p.version, ...PROFILE, photo_ids: [fake] },
    });
    expect(r2.status).toBe(415);
    expect(r2.body.error.code).toBe('MEDIA_TYPE_UNSUPPORTED');
    expect(storage.keys(`incoming/${ORG}/venues/${RMS}/`)).toEqual([]); // never kept
    expect((await profile()).version).toBe(p.version);
    // an unsupported type is refused when the upload is requested
    const r3 = await t.command('post', path(RMS, '/photos'), {
      as: 'OWN1',
      body: { content_type: 'application/pdf', byte_size: 10 },
    });
    expect(r3.status).toBe(415);
  });

  it('submit needs the address, city, position and hours (required_to_submit per field)', async () => {
    const created = await t.command('put', path(LYL), {
      as: 'OWN1',
      body: {
        expected_version: 0,
        category: 'hall',
        address: null,
        city: null,
        lat: null,
        lng: null,
        opening_hours: { always_open: false, days: {} },
        photo_ids: [],
      },
    });
    expect(created.status).toBe(200);
    const r = await t.command('post', path(LYL, '/submit'), { as: 'ADM1', body: { expected_version: 1 } });
    expect(r.status).toBe(422);
    expect(r.body.error.details.fields.map((f: { field: string }) => f.field)).toEqual([
      'address',
      'city',
      'lat',
      'opening_hours',
    ]);
  });

  it('submit: draft → submitted, replayed with the same key (one transition, one audit row)', async () => {
    const p = await profile();
    const key = newKey();
    const first = await t.command('post', path(RMS, '/submit'), {
      as: 'ADM1',
      body: { expected_version: p.version },
      key,
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: 'submitted', version: p.version + 1 });
    const again = await t.command('post', path(RMS, '/submit'), {
      as: 'ADM1',
      body: { expected_version: p.version },
      key,
    });
    expect(again.status).toBe(200);
    expect(again.body.meta.replayed).toBe(true);
    expect(again.body.data.version).toBe(p.version + 1);
    const rows = await t.db.query(
      `SELECT 1 FROM audit_log WHERE entity_id = $1 AND metadata->>'command' = 'POST /v1/venues/{venueId}/public-profile/submit'`,
      [RMS],
    );
    expect(rows.rowCount).toBe(1);
    // a second submit is a state error
    const twice = await t.command('post', path(RMS, '/submit'), {
      as: 'ADM1',
      body: { expected_version: p.version + 1 },
    });
    expect(twice.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { current_status: 'submitted', allowed_from: ['draft'] },
    });
  });
});

describe('platform side (P-04)', () => {
  it('lists the submissions (status, operator, city filters) and opens one with its operator', async () => {
    const list = await pget('admin', '/v1/platform/venues?status=submitted');
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: { venue_id: string }) => x.venue_id)).toEqual([RMS]);
    expect(list.body.data[0]).toMatchObject({ org: { id: ORG }, photo_count: 1, status: 'submitted' });
    expect((await pget('owner', `/v1/platform/venues?org_id=${B.org}`)).body.data).toEqual([]);
    expect(
      (await pget('owner', `/v1/platform/venues?city=${encodeURIComponent('الرياض')}`)).body.data,
    ).toHaveLength(1);
    const all = await pget('owner', '/v1/platform/venues?limit=1');
    expect(all.body.data).toHaveLength(1);
    const next = await pget('owner', `/v1/platform/venues?limit=1&cursor=${all.body.meta.next_cursor}`);
    expect(next.body.data).toHaveLength(1);
    expect(next.body.data[0].venue_id).not.toBe(all.body.data[0].venue_id);
    const one = await pget('admin', `/v1/platform/venues/${RMS}`);
    expect(one.body.data).toMatchObject({ venue_id: RMS, org: { id: ORG, operator_status: 'active' } });
    expect(storage.download(one.body.data.photos[0].url).status).toBe(200);
    expect((await pget('admin', `/v1/platform/venues/${randomUUID()}`)).body.error).toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      details: { resource: 'venue_public_profile' },
    });
  });

  it('send back needs a reason; the operator sees it until resubmitting', async () => {
    const v = (await profile()).version;
    const none = await pcmd('admin', 'post', `/v1/platform/venues/${RMS}/send-back`, { expected_version: v });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('REASON_REQUIRED');
    const back = await pcmd('admin', 'post', `/v1/platform/venues/${RMS}/send-back`, {
      expected_version: v,
      reason: 'الصورة غير واضحة',
    });
    expect(back.status).toBe(200);
    expect(back.body.data.status).toBe('draft');
    const p = await profile();
    expect(p.review_note).toMatchObject({ kind: 'sent_back', reason: 'الصورة غير واضحة' });
    // both audit trails, the operator's with the platform actor
    const pa = await t.db.query(
      `SELECT actor_id, actor_role, org_id, reason FROM platform_audit_log WHERE action = 'venue_profile.send_back'`,
    );
    expect(pa.rows).toEqual([
      { actor_id: platform.admin.id, actor_role: 'platform_admin', org_id: ORG, reason: 'الصورة غير واضحة' },
    ]);
    const oa = await t.db.query(
      `SELECT actor_type, actor_id, org_id FROM audit_log WHERE action = 'venue_profile.send_back'`,
    );
    expect(oa.rows).toEqual([
      { actor_type: 'system', actor_id: `platform:${platform.admin.id}`, org_id: ORG },
    ]);
    // the note survives an edit and goes with the resubmission
    const edited = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: {
        expected_version: p.version,
        ...PROFILE,
        category: 'office',
        photo_ids: p.photos.map((x: { id: string }) => x.id),
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.review_note?.kind).toBe('sent_back');
    const sub = await t.command('post', path(RMS, '/submit'), {
      as: 'OWN1',
      body: { expected_version: edited.body.data.version },
    });
    expect(sub.body.data).toMatchObject({ status: 'submitted', review_note: null });
  });

  it('approve lists it; the public read model shows it with presigned photos and «open now»', async () => {
    const v = (await profile()).version;
    expect(
      (await pcmd('admin', 'post', `/v1/platform/venues/${RMS}/approve`, { expected_version: v - 1 })).body
        .error.code,
    ).toBe('VERSION_CONFLICT');
    const ok = await pcmd('admin', 'post', `/v1/platform/venues/${RMS}/approve`, { expected_version: v });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'approved', approved_by: platform.admin.id });
    const listed = await listPublicLocations(t.db, {}, signer());
    expect(listed.map((l) => l.venue_id)).toEqual([RMS]);
    expect(listed[0]).toMatchObject({
      name_ar: 'قاعة ريماس',
      category: 'office',
      operator_name_ar: expect.any(String),
      city: 'الرياض',
      timezone: 'Asia/Riyadh',
      subscriptions_enabled: false,
    });
    expect(listed[0]!.photos[0]!.url).toMatch(/X-Mem-Signature/);
    expect(storage.download(listed[0]!.photos[0]!.url).status).toBe(200);
    // the fake clock is Tuesday 19:00 Riyadh: Tuesday has no hours → closed
    expect(listed[0]!.open_now).toBe(false);
    expect(await listPublicLocations(t.db, { openNow: true }, signer())).toEqual([]);
    expect(await listPublicLocations(t.db, { category: 'mall' }, signer())).toEqual([]);
    expect((await listPublicLocations(t.db, { search: 'ريماس' }, signer())).length).toBe(1);
    expect((await getPublicLocation(t.db, RMS, signer()))?.venue_id).toBe(RMS);
    expect(await getPublicLocation(t.db, LYL, signer())).toBeNull(); // a draft is not listed
  });

  it('pricing is the platform’s (plan_manage: owner/finance); halls sell no subscription', async () => {
    const v = (await profile()).version;
    const body = { expected_version: v, subscriptions_enabled: true, pay_per_visit_halalas: 2000 };
    expect((await pcmd('admin', 'put', `/v1/platform/venues/${RMS}/pricing`, body)).body.error.code).toBe(
      'PERMISSION_DENIED',
    );
    expect((await pcmd('support', 'put', `/v1/platform/venues/${RMS}/pricing`, body)).status).toBe(403);
    const priced = await pcmd('finance', 'put', `/v1/platform/venues/${RMS}/pricing`, body);
    expect(priced.status).toBe(200);
    expect(priced.body.data).toMatchObject({
      status: 'approved',
      subscriptions_enabled: true,
      pay_per_visit_halalas: 2000,
    });
    expect((await profile()).pay_per_visit_halalas).toBe(2000);
    const hall = await pcmd('owner', 'put', `/v1/platform/venues/${LYL}/pricing`, {
      expected_version: 1,
      subscriptions_enabled: true,
      pay_per_visit_halalas: null,
    });
    expect(hall.status).toBe(422);
    expect(hall.body.error.details.fields[0]).toMatchObject({
      field: 'subscriptions_enabled',
      issue: 'not_recurring_venue',
    });
    // the operator cannot turn an approved subscription venue into a hall
    const p = await profile();
    const toHall = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: {
        expected_version: p.version,
        ...PROFILE,
        category: 'hall',
        photo_ids: p.photos.map((x: { id: string }) => x.id),
      },
    });
    expect(toHall.body.error.details.fields[0]).toMatchObject({
      field: 'category',
      issue: 'subscriptions_enabled',
    });
    // finance and support do not review (P-04 is owner/admin)
    expect((await pget('finance', '/v1/platform/venues')).body.error.code).toBe('PERMISSION_DENIED');
    expect((await pget('support', `/v1/platform/venues/${RMS}`)).body.error.code).toBe('PERMISSION_DENIED');
  });

  it('an identical save of an approved profile is a no-op; a change takes it off the map until approved again', async () => {
    const p = await profile();
    const same = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: {
        expected_version: p.version,
        ...PROFILE,
        category: 'office',
        // the same week typed in another order
        opening_hours: {
          always_open: false,
          days: { fri: HOURS.days.fri, thu: [...HOURS.days.thu].reverse(), sun: HOURS.days.sun },
        },
        photo_ids: p.photos.map((x: { id: string }) => x.id),
      },
    });
    expect(same.body.data).toMatchObject({ status: 'approved', version: p.version });
    const changed = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: { expected_version: p.version, ...PROFILE, category: 'office', city: 'جدة', photo_ids: [] },
    });
    expect(changed.body.data).toMatchObject({ status: 'draft', approved_at: null, photos: [] });
    expect(await listPublicLocations(t.db, {}, signer())).toEqual([]);
    const sub = await t.command('post', path(RMS, '/submit'), {
      as: 'OWN1',
      body: { expected_version: changed.body.data.version },
    });
    const ok = await pcmd('owner', 'post', `/v1/platform/venues/${RMS}/approve`, {
      expected_version: sub.body.data.version,
    });
    expect(ok.body.data.status).toBe('approved');
  });

  it('hide (reason) takes it off the map and locks the operator out; unhide (reason) lists it again', async () => {
    const v = (await profile()).version;
    const hidden = await pcmd('admin', 'post', `/v1/platform/venues/${RMS}/hide`, {
      expected_version: v,
      reason: 'شكوى من العملاء',
    });
    expect(hidden.body.data.status).toBe('hidden');
    expect(await getPublicLocation(t.db, RMS, signer())).toBeNull();
    const p = await profile();
    expect(p.review_note).toMatchObject({ kind: 'hidden', reason: 'شكوى من العملاء' });
    const edit = await t.command('put', path(RMS), {
      as: 'OWN1',
      body: { expected_version: p.version, ...PROFILE, photo_ids: [] },
    });
    expect(edit.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { current_status: 'hidden', reason: 'hidden_by_platform' },
    });
    expect(
      (await t.command('post', path(RMS, '/submit'), { as: 'OWN1', body: { expected_version: p.version } }))
        .status,
    ).toBe(409);
    expect(
      (await pcmd('admin', 'post', `/v1/platform/venues/${RMS}/unhide`, { expected_version: p.version })).body
        .error.code,
    ).toBe('REASON_REQUIRED');
    const back = await pcmd('admin', 'post', `/v1/platform/venues/${RMS}/unhide`, {
      expected_version: p.version,
      reason: 'عولجت الشكوى',
    });
    expect(back.body.data).toMatchObject({ status: 'approved', review_note: null });
    expect((await getPublicLocation(t.db, RMS, signer()))?.venue_id).toBe(RMS);
  });

  it('the public read model drops a suspended operator and an inactive venue', async () => {
    await t.db.query(`UPDATE organizations SET operator_status = 'suspended' WHERE id = $1`, [ORG]);
    expect(await listPublicLocations(t.db, {}, signer())).toEqual([]);
    await t.db.query(`UPDATE organizations SET operator_status = 'active' WHERE id = $1`, [ORG]);
    await t.db.query(`UPDATE venues SET status = 'inactive' WHERE id = $1`, [RMS]);
    expect(await getPublicLocation(t.db, RMS, signer())).toBeNull();
    await t.db.query(`UPDATE venues SET status = 'active' WHERE id = $1`, [RMS]);
    expect((await listPublicLocations(t.db, {}, signer())).map((l) => l.venue_id)).toEqual([RMS]);
  });
});

describe('isolation and permissions', () => {
  it('another operator’s owner/admin gets the not-found answer for every route of A’s venue (as for no venue)', async () => {
    for (const as of [B.user('OWN1'), B.user('ADM1')]) {
      for (const venue of [RMS, randomUUID()]) {
        const get = await t.get(path(venue), as);
        expect([get.status, get.body.error.code, get.body.error.details]).toEqual([
          404,
          'RESOURCE_NOT_FOUND',
          { resource: 'venue' },
        ]);
        const put = await t.command('put', path(venue), { as, body: { expected_version: 0, ...PROFILE } });
        expect(put.body.error.code).toBe('RESOURCE_NOT_FOUND');
        const sub = await t.command('post', path(venue, '/submit'), { as, body: { expected_version: 1 } });
        expect(sub.body.error.code).toBe('RESOURCE_NOT_FOUND');
        const photo = await t.command('post', path(venue, '/photos'), {
          as,
          body: { content_type: 'image/jpeg', byte_size: 10 },
        });
        expect(photo.body.error.code).toBe('RESOURCE_NOT_FOUND');
      }
    }
    // B's own venue works, and B's profile is invisible to A
    const own = await t.command('put', path(B.venue), {
      as: B.user('OWN1'),
      body: { expected_version: 0, ...PROFILE },
    });
    expect(own.status).toBe(200);
    expect((await t.get(path(B.venue), 'OWN1')).status).toBe(404);
  });

  it('supervisors and drivers hold no venue.manage', async () => {
    for (const as of ['SUP-R', 'SUP-RD', 'DRV1'] as const) {
      expect((await t.get(path(RMS), as)).body.error.code).toBe('PERMISSION_DENIED');
      expect((await t.command('put', path(RMS), { as, body: {} })).body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('a staff session never opens a platform route, and a platform session never opens a staff route', async () => {
    const staff = await t
      .http()
      .get('/v1/platform/venues')
      .set('Cookie', await t.sessionFor('OWN1'));
    expect([staff.status, staff.body.error.code]).toEqual([401, 'PLATFORM_AUTH_REQUIRED']);
    const plat = await t.http().get(path(RMS)).set('Cookie', platform.owner.cookie);
    expect([plat.status, plat.body.error.code]).toEqual([401, 'AUTH_UNAUTHENTICATED']);
  });

  it('platform commands require the Idempotency-Key and replay with it', async () => {
    const v = (await profile()).version;
    const missing = await pcmd('owner', 'put', `/v1/platform/venues/${RMS}/pricing`, {}, null);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = newKey();
    const body = { expected_version: v, subscriptions_enabled: false, pay_per_visit_halalas: null };
    const a = await pcmd('owner', 'put', `/v1/platform/venues/${RMS}/pricing`, body, key);
    const b = await pcmd('owner', 'put', `/v1/platform/venues/${RMS}/pricing`, body, key);
    expect(a.status).toBe(200);
    expect(b.body.meta.replayed).toBe(true);
    expect(b.body.data.version).toBe(a.body.data.version);
    const n = await t.db.query(`SELECT 1 FROM platform_audit_log WHERE action = 'venue_profile.pricing'`);
    expect(n.rowCount).toBe(2); // the finance price and this one; the replay wrote nothing
  });
});
