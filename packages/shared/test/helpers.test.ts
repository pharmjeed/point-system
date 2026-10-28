import { describe, expect, it } from 'vitest';
import {
  BRAND_DEFAULTS,
  ClientHeartbeatSchema,
  MASK_CHAR,
  SCREEN_IDS,
  SOUNDS,
  TicketStatusSchema,
  isActiveMovementTaskStatus,
  isOpenTaskStatus,
  isTerminalTicketStatus,
  maskPhone,
  resolveBrand,
  soundUrl,
  successEnvelopeSchema,
  waTemplateById,
  waTemplateByName,
  wsEnvelopeSchema,
} from '../src/index.js';
import { z } from 'zod';
import { readDoc } from './docs.js';

describe('maskPhone (canon §15)', () => {
  it('masks Saudi numbers in the national form 05•••••123', () => {
    expect(maskPhone('+966512345123')).toBe(`05${MASK_CHAR.repeat(5)}123`);
    expect(maskPhone('+966512345123')).toBe('05•••••123');
  });

  it('masks other E.164 numbers keeping the country prefix', () => {
    expect(maskPhone('+447911123456')).toBe('+44•••••••456');
  });

  it('never leaks an invalid value', () => {
    expect(maskPhone('0512345123')).toBe('•••••');
    expect(maskPhone('')).toBe('•••••');
    expect(maskPhone(null)).toBe('•••••');
    expect(maskPhone(undefined)).toBe('•••••');
  });
});

describe('brand defaults (canon §1)', () => {
  it('match the canon §1 variables and defaults', () => {
    const line =
      readDoc('00_Glossary_Canon.md')
        .split('\n')
        .find((l) => l.includes('`BRAND_STAFF_NAME_AR=')) ?? '';
    const pairs = Object.fromEntries([...line.matchAll(/`(BRAND_\w+)=([^`]+)`/g)].map((m) => [m[1], m[2]]));
    expect(BRAND_DEFAULTS).toEqual(pairs);
  });

  it('resolveBrand reads env, falls back on blanks, and supports the VITE_ prefix', () => {
    expect(resolveBrand({})).toEqual({
      staffNameAr: BRAND_DEFAULTS.BRAND_STAFF_NAME_AR,
      staffNameEn: BRAND_DEFAULTS.BRAND_STAFF_NAME_EN,
      customerNameAr: BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR,
      customerNameEn: BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_EN,
    });
    expect(resolveBrand({ BRAND_STAFF_NAME_EN: 'X', BRAND_CUSTOMER_NAME_EN: '  ' }).staffNameEn).toBe('X');
    expect(resolveBrand({ BRAND_CUSTOMER_NAME_EN: '  ' }).customerNameEn).toBe(
      BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_EN,
    );
    expect(resolveBrand({ VITE_BRAND_STAFF_NAME_EN: 'Y' }, 'VITE_').staffNameEn).toBe('Y');
  });
});

describe('status helpers', () => {
  it('classify ticket and task statuses', () => {
    expect(isTerminalTicketStatus('delivered')).toBe(true);
    expect(isTerminalTicketStatus('ready')).toBe(false);
    expect(isOpenTaskStatus('assigned_waiting')).toBe(true);
    expect(isOpenTaskStatus('canceled')).toBe(false);
    expect(isActiveMovementTaskStatus('accepted')).toBe(true);
    expect(isActiveMovementTaskStatus('assigned_waiting')).toBe(false);
    expect(TicketStatusSchema.safeParse('expired').success).toBe(false);
  });
});

describe('sounds, screens, templates', () => {
  it('sound URLs point to the web public folder', () => {
    expect(soundUrl('next_due')).toBe('/sounds/point-next-due.mp3');
    expect(SOUNDS.test.source).toBe('brand/sounds/point-test.mp3');
  });

  it('screen ids are unique', () => {
    expect(new Set(SCREEN_IDS).size).toBe(SCREEN_IDS.length);
    expect(SCREEN_IDS).toHaveLength(15 + 13 + 12);
  });

  it('templates are found by id and name', () => {
    expect(waTemplateById('W-05').variable_names).toEqual(['display_number', 'claim_code']);
    expect(waTemplateByName('reply_opted_out')?.id).toBe('W-12');
    expect(waTemplateByName('nope')).toBeUndefined();
  });
});

describe('envelopes', () => {
  it('validate success envelopes with and without a cursor', () => {
    const schema = successEnvelopeSchema(z.object({ ok: z.boolean() }));
    expect(
      schema.safeParse({
        data: { ok: true },
        meta: { request_id: 'req_1', server_time: '2026-10-29T18:42:10.120Z' },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        data: { ok: true },
        meta: {
          request_id: 'req_1',
          server_time: '2026-10-29T18:42:10.120Z',
          next_cursor: null,
          replayed: true,
        },
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ data: { ok: true }, meta: { request_id: 'req_1' } }).success).toBe(false);
  });

  it('validates the realtime envelope example of 07 §4.2', () => {
    const schema = wsEnvelopeSchema(z.record(z.string(), z.unknown()));
    const example = {
      id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      type: 'task.claimed',
      occurred_at: '2026-10-29T21:05:19.300Z',
      org_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      venue_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      dispatch_pool_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      event_id: '5e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
      aggregate: { type: 'task', id: '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c', version: 3 },
      actor: { type: 'user', id: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d' },
      payload: { cause: 'task.claimed', result: 'accepted' },
    };
    expect(schema.parse(example)).toEqual(example);
    expect(schema.safeParse({ ...example, type: 'task.created' }).success).toBe(false);
  });

  it('heartbeat payload rejects unknown fields', () => {
    expect(ClientHeartbeatSchema.safeParse({ visible: true, audio_unlocked: false }).success).toBe(true);
    expect(ClientHeartbeatSchema.safeParse({ visible: true, audio_unlocked: false, gps: 1 }).success).toBe(
      false,
    );
  });
});
