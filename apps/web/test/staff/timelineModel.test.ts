import { describe, expect, it } from 'vitest';
import type { TicketTimeline } from '@/api/types';
import { stripBidiMarks } from '@/lib/format';
import {
  buildTimeline,
  CODE_MASK,
  custodyLine,
  holderText,
  layoutLabels,
  maskCodes,
  messageLine,
} from '@/features/supervisor/timelineModel';
import { ticketDetail, ticketSummary } from './fixtures';

describe('S-03 handover code never on screen (DEC-38)', () => {
  it('masks a standalone 6-digit run in a message preview', () => {
    expect(maskCodes('رمز التسليم: 482913 صالح 30 دقيقة')).toBe(`رمز التسليم: ${CODE_MASK} صالح 30 دقيقة`);
    expect(maskCodes('482913')).toBe(CODE_MASK);
    expect(maskCodes('الرمز(482913).')).toBe(`الرمز(${CODE_MASK}).`);
  });

  it('leaves other numbers alone (ticket numbers, longer digit runs, amounts)', () => {
    expect(maskCodes('تذكرة #47 — 25.00 ر.س')).toBe('تذكرة #47 — 25.00 ر.س');
    expect(maskCodes('0551234567')).toBe('0551234567');
    expect(maskCodes('1234567')).toBe('1234567');
  });
});

describe('S-03 timeline', () => {
  const people = new Map([['d-1', 'خالد']]);
  const labels = new Map([
    ['spot-3', 'A-03'],
    ['slot-12', '12'],
  ]);

  it('writes custody holders from 02 §8.2 «الحائز»', () => {
    expect(holderText('driver', 'd-1', people)).toBe('السائق خالد');
    expect(holderText('driver', 'd-unknown', people)).toBe('السائق');
    expect(holderText('spot', 'spot-3', people, labels)).toBe('الموقف A-03');
    expect(holderText('key_slot', null, people, labels)).toBe('الخانة');
    expect(holderText('customer', null, people)).toBe('العميل');
  });

  it('writes a custody line «السبب: من ← إلى»', () => {
    const line = custodyLine(
      {
        id: 'c-1',
        ticket_id: 't-1',
        subject: 'vehicle',
        from_holder_type: 'driver',
        from_holder_id: 'd-1',
        to_holder_type: 'spot',
        to_holder_id: 'spot-3',
        reason: 'parked',
        actor: { id: 'd-1', full_name: 'خالد' },
        occurred_at: '2026-10-29T17:00:00Z',
      },
      people,
      labels,
    );
    expect(line).toBe('صف: السائق خالد ← الموقف A-03');
  });

  it('merges ticket events, custody and messages, newest first, masking codes', () => {
    const timeline: TicketTimeline = {
      ticket: ticketSummary(),
      events: [
        {
          id: 1,
          type: 'ticket.intake_submitted',
          actor_type: 'user',
          actor_id: 'd-1',
          ticket_version: 2,
          occurred_at: '2026-10-29T16:00:00Z',
        },
        {
          id: 2,
          type: 'ticket.retrieval_requested',
          actor_type: 'customer',
          ticket_version: 4,
          occurred_at: '2026-10-29T18:00:00Z',
        },
        {
          id: 3,
          type: 'ticket.parked',
          actor_type: 'user',
          actor_id: 'd-1',
          ticket_version: 3,
          data: { parking_spot_id: 'spot-3', key_slot_id: 'slot-12' },
          occurred_at: '2026-10-29T16:10:00Z',
        },
      ],
      custody: [
        {
          id: 'c-1',
          ticket_id: 't-1',
          subject: 'key',
          from_holder_type: 'driver',
          from_holder_id: 'd-1',
          to_holder_type: 'key_slot',
          to_holder_id: 'slot-12',
          reason: 'key_deposited',
          actor: { id: 'd-1', full_name: 'خالد' },
          occurred_at: '2026-10-29T16:09:00Z',
        },
      ],
      cycles: [],
      tasks: [],
      messages: [
        {
          id: 'm-1',
          direction: 'outbound',
          kind: 'template',
          purpose: 'W-05',
          status: 'failed',
          status_rank: 5,
          error_title: 'Re-engagement message',
          body_redacted: 'سيارتك جاهزة. رمز التسليم: 482913',
          failed_at: '2026-10-29T18:05:00Z',
        },
        { id: 'm-2', direction: 'outbound', kind: 'template', status: 'queued', status_rank: 0 },
      ],
      payments: [],
      incidents: [],
    };
    const lines = buildTimeline(timeline, ticketDetail(), labels);
    expect(lines.map((l) => l.kind)).toEqual(['whatsapp', 'ticket', 'ticket', 'custody', 'ticket']);
    const [message, requested, parked, custody, issued] = lines;
    expect(message).toMatchObject({ text: 'W-05 — فشلت', failed: true, actor: 'Re-engagement message' });
    expect(message?.message).toBe(`سيارتك جاهزة. رمز التسليم: ${CODE_MASK}`);
    expect(JSON.stringify(lines)).not.toContain('482913');
    expect(requested).toMatchObject({ text: 'طلب السيارة', actor: 'العميل عبر واتساب' });
    expect(parked?.text).toBe('صف في A-03 وإيداع المفتاح في 12');
    expect(custody?.text).toBe('إيداع المفتاح: السائق خالد ← الخانة 12');
    expect(issued).toMatchObject({ text: 'إصدار التذكرة', actor: 'خالد' });
    expect(stripBidiMarks(issued?.time ?? '')).toBe('7:00 م');
  });

  it('labels a message by its purpose and status', () => {
    expect(
      messageLine({
        id: 'm',
        direction: 'inbound',
        kind: 'inbound_button',
        status: 'received',
        status_rank: 0,
      }),
    ).toBe('من العميل — واردة');
  });

  it('collects the spot and key-slot labels the ticket carries', () => {
    const labels2 = layoutLabels(
      ticketDetail({
        current_spot: { id: 's-1', label: 'B-07' },
        current_key_slot: { id: 'k-1', label: '31' },
        vehicle_holder: { type: 'spot', id: 's-1', label: 'B-07' },
      }),
    );
    expect([...labels2.entries()]).toEqual([
      ['s-1', 'B-07'],
      ['k-1', '31'],
    ]);
  });
});
