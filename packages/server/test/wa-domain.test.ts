import { waCatalog, waTemplateParams } from '@point/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyGraphFailure,
  sanitizeProviderMessage,
} from '../src/modules/whatsapp/domain/graph-errors.js';
import {
  extractLinkCode,
  isOptOutKeyword,
  normalizeInboundText,
} from '../src/modules/whatsapp/domain/inbound-text.js';
import {
  effectiveGlobalMps,
  failingStreakExceeded,
  orderingGateWaitMs,
  pairBucketWaitMs,
  sendRetryDelayMs,
  slidingSecondWaitMs,
  temporaryErrorRateExceeded,
  venueShare,
} from '../src/modules/whatsapp/domain/pacing.js';
import {
  CODE_MASK,
  TOKEN_MASK,
  buildSessionMessage,
  buildTemplateMessage,
  messageIdFromOpaque,
  opaqueFor,
  vehicleSummary,
} from '../src/modules/whatsapp/domain/render.js';
import {
  sendTimeSkipReason,
  w09VariantFor,
  type SendFacts,
} from '../src/modules/whatsapp/domain/send-rules.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 16, 0, 0) + s * 1000);
const NOW = at(0);

describe('12 §5.9 retry schedule', () => {
  it('1, 4, 16, 64, 256 s ±20 %', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => sendRetryDelayMs(n, () => 0.5))).toEqual([
      1000, 4000, 16000, 64000, 256000, 256000,
    ]);
    expect(sendRetryDelayMs(1, () => 0)).toBe(800);
    expect(sendRetryDelayMs(1, () => 1)).toBe(1200);
  });
});

describe('12 §5.7 per-recipient bucket (capacity 6, one message every 6 s)', () => {
  it('a burst of 6 passes, the 7th waits one refill', () => {
    const sends = Array.from({ length: 6 }, () => NOW);
    expect(pairBucketWaitMs(sends.slice(0, 5), NOW, 6, 6)).toBe(0);
    expect(pairBucketWaitMs(sends, NOW, 6, 6)).toBe(6000);
    expect(pairBucketWaitMs(sends, at(4), 6, 6)).toBe(2000);
    expect(pairBucketWaitMs(sends, at(6), 6, 6)).toBe(0);
    expect(pairBucketWaitMs([...sends, at(6)], at(6), 6, 6)).toBe(6000);
  });

  it('old sends refill the bucket', () => {
    expect(
      pairBucketWaitMs(
        Array.from({ length: 20 }, (_, i) => at(-600 + i)),
        NOW,
        6,
        6,
      ),
    ).toBe(0);
  });
});

describe('12 §5.8 global ceiling', () => {
  it('sliding second', () => {
    const recent = [at(-0.9), at(-0.5), at(-0.1)];
    expect(slidingSecondWaitMs(recent, NOW, 4)).toBe(0);
    expect(slidingSecondWaitMs(recent, NOW, 3)).toBe(100);
    expect(slidingSecondWaitMs([at(-1.5)], NOW, 1)).toBe(0);
  });

  it('130429 slows down by 20 %; venues share the ceiling', () => {
    expect(effectiveGlobalMps(60, false)).toBe(60);
    expect(effectiveGlobalMps(60, true)).toBe(48);
    expect(venueShare(60, 1)).toBe(60);
    expect(venueShare(60, 3)).toBe(20);
    expect(venueShare(1, 5)).toBe(1);
  });
});

describe('12 §5.6 ordering gate', () => {
  const prev = (status: string, statusRank: number, acceptedAt = at(-2)) => ({
    acceptedAt,
    status,
    statusRank,
  });
  it('waits for delivered/read/failed or 8 s after acceptance', () => {
    expect(orderingGateWaitMs(null, NOW, 8)).toBe(0);
    expect(orderingGateWaitMs(prev('queued', 0), NOW, 8)).toBe(6000);
    expect(orderingGateWaitMs(prev('sent', 1), NOW, 8)).toBe(6000);
    expect(orderingGateWaitMs(prev('delivered', 2), NOW, 8)).toBe(0);
    expect(orderingGateWaitMs(prev('read', 3), NOW, 8)).toBe(0);
    expect(orderingGateWaitMs(prev('failed', 0), NOW, 8)).toBe(0);
    expect(orderingGateWaitMs(prev('sent', 1, at(-9)), NOW, 8)).toBe(0);
  });
});

describe('12 §5.14 channel health rules', () => {
  it('temporary error rate > 20 % over at least 5 attempts', () => {
    expect(temporaryErrorRateExceeded(4, 4)).toBe(false);
    expect(temporaryErrorRateExceeded(5, 1)).toBe(false);
    expect(temporaryErrorRateExceeded(5, 2)).toBe(true);
  });
  it('every attempt failing for 2 minutes', () => {
    expect(failingStreakExceeded(null, NOW)).toBe(false);
    expect(failingStreakExceeded(at(-119), NOW)).toBe(false);
    expect(failingStreakExceeded(at(-120), NOW)).toBe(true);
  });
});

describe('12 §5.9 error classes (by Graph code)', () => {
  const http = (status: number, code: number | null) =>
    classifyGraphFailure({ kind: 'http', status, code, message: '' });
  it('temporary, throughput, pair limit', () => {
    expect(http(503, null)).toMatchObject({ cls: 'temporary', retryable: true, providerCode: 'http_503' });
    expect(http(400, 131000)).toMatchObject({ cls: 'temporary', retryable: true });
    expect(http(429, 130429)).toMatchObject({ cls: 'throughput', retryable: true });
    expect(http(400, 131056)).toMatchObject({ cls: 'pair_limit', retryable: true });
    expect(classifyGraphFailure({ kind: 'timeout', status: null, code: null, message: '' })).toMatchObject({
      cls: 'temporary',
      internalCode: 'DEPENDENCY_TIMEOUT',
      providerCode: 'timeout',
    });
  });
  it('permanent classes', () => {
    expect(http(400, 131026)).toMatchObject({
      cls: 'recipient',
      retryable: false,
      internalCode: 'WA_SEND_FAILED',
    });
    expect(http(400, 131047)).toMatchObject({ cls: 'outside_window', retryable: false });
    expect(http(400, 131051)).toMatchObject({ cls: 'programming', retryable: false });
    expect(http(400, 999999)).toMatchObject({ cls: 'programming', retryable: false });
    expect(http(400, 132015)).toMatchObject({
      cls: 'template',
      internalCode: 'WA_TEMPLATE_NOT_APPROVED',
      templateStatus: 'paused',
      channel: 'degraded',
    });
    expect(http(400, 132016)).toMatchObject({ templateStatus: 'disabled' });
  });
  it('channel class stops sending (down), quality degrades', () => {
    expect(http(401, 190)).toMatchObject({
      cls: 'channel',
      channel: 'down',
      internalCode: 'WA_CHANNEL_UNAVAILABLE',
    });
    expect(http(400, 131031)).toMatchObject({ cls: 'channel', channel: 'down' });
    expect(http(403, 200)).toMatchObject({ cls: 'channel' });
    expect(http(400, 131048)).toMatchObject({ cls: 'quality', channel: 'degraded', retryable: true });
  });
  it('provider messages lose phone numbers and wamids', () => {
    expect(sanitizeProviderMessage('Recipient +966 55 123 4567 wamid.HBgLOTY2NTUx unknown')).toBe(
      'Recipient ••• wamid.••• unknown',
    );
  });
});

describe('12 §6.6 inbound text', () => {
  it('normalizes digits, tatweel, case and spaces', () => {
    expect(normalizeInboundText('  ايـقاف  ')).toBe('ايقاف');
    expect(normalizeInboundText('stop')).toBe('STOP');
    expect(normalizeInboundText('٤٨٢٧٣١')).toBe('482731');
  });
  it('stop words are exact (PNT-048); «إلغاء» is not one', () => {
    for (const w of ['إيقاف', 'ايقاف', 'أوقف', 'stop', ' Stop ', 'unsubscribe'])
      expect(isOptOutKeyword(normalizeInboundText(w))).toBe(true);
    for (const w of ['إلغاء', 'إيقاف الرسائل من فضلك', 'stop please'])
      expect(isOptOutKeyword(normalizeInboundText(w))).toBe(false);
  });
  it('link codes: the prefilled text, the bare code, dashes and spaces; never inside random text', () => {
    const n = normalizeInboundText;
    expect(extractLinkCode(n('ربط تذكرة K7Q29F'))).toBe('K7Q29F');
    expect(extractLinkCode(n('ربط k7q-29f'))).toBe('K7Q29F');
    expect(extractLinkCode(n('ربط K7Q 29F'))).toBe('K7Q29F');
    expect(extractLinkCode(n('k7q29f'))).toBe('K7Q29F');
    expect(extractLinkCode(n('K7Q-29F'))).toBe('K7Q29F');
    expect(extractLinkCode(n('ABCDEF?'))).toBeNull();
    expect(extractLinkCode(n('hello there friend'))).toBeNull();
    expect(extractLinkCode(n('ربط O0I1AB'))).toBeNull(); // ambiguous characters are not in the alphabet
    expect(extractLinkCode(n('مرحبا ABCDEF'))).toBeNull(); // no «ربط» and not the whole message
  });
});

describe('12 §5.11 rendering', () => {
  it('vehicle summary: make model color — plate digits, ≤ 60 characters, never plate letters', () => {
    expect(
      vehicleSummary({
        vehicle_make: 'تويوتا',
        vehicle_model: 'كامري',
        vehicle_color: 'بيضاء',
        plate_digits: '4821',
      }),
    ).toBe('تويوتا كامري بيضاء — لوحة 4821');
    // the make and the colour are stored as the 02 §8.4 keys (DEC-350): the customer reads Arabic labels
    expect(
      vehicleSummary({
        vehicle_make: 'toyota',
        vehicle_model: 'كامري',
        vehicle_color: 'white',
        plate_digits: '4821',
      }),
    ).toBe('تويوتا كامري أبيض — لوحة 4821');
    expect(
      vehicleSummary({
        vehicle_make: 'land_rover',
        vehicle_model: null,
        vehicle_color: null,
        plate_digits: null,
      }),
    ).toBe('لاند روفر');
    expect(
      vehicleSummary({
        vehicle_make: 'بروتون',
        vehicle_model: null,
        vehicle_color: 'عنابي',
        plate_digits: '7',
      }),
    ).toBe('بروتون عنابي — لوحة 7');
    expect(
      vehicleSummary({ vehicle_make: null, vehicle_model: null, vehicle_color: null, plate_digits: null }),
    ).toBe('—');
    expect(
      vehicleSummary({
        vehicle_make: 'x'.repeat(80),
        vehicle_model: null,
        vehicle_color: null,
        plate_digits: '1',
      }).length,
    ).toBeLessThanOrEqual(60);
  });

  it('W-01: body parameters, the quick-reply token, the opaque id; redacted copies never hold the token', () => {
    const m = buildTemplateMessage({
      catalog: waCatalog('BRAND_X'),
      purpose: 'W-01',
      recipient: { to: '+966551234567', recipient: null },
      params: ['قاعة\nريماس', '125', 'تويوتا'],
      buttonPayload: 'rq1.secret-token-value',
      opaque: opaqueFor('0190d2a4-1111-7000-8000-000000000001'),
    });
    expect(m.request).toMatchObject({
      to: '+966551234567',
      type: 'template',
      template: { name: 'masaf_ticket_issued_v1', language: { code: 'ar' } },
      biz_opaque_callback_data: 'wam:0190d2a4-1111-7000-8000-000000000001',
    });
    const components = (m.request.template as { components: unknown[] }).components;
    expect(components).toEqual([
      { type: 'body', parameters: ['قاعة ريماس', '125', 'تويوتا'].map((text) => ({ type: 'text', text })) },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'rq1.secret-token-value' }],
      },
    ]);
    expect(JSON.stringify(m.payloadRedacted)).not.toContain('rq1.secret-token-value');
    expect(JSON.stringify(m.payloadRedacted)).toContain(TOKEN_MASK);
    expect(m.payloadRedacted.to).toBe('•••567');
    expect(m.bodyRedacted).toContain('تذكرة 125');
    // the customer brand comes from configuration (DEC-470)
    expect(m.bodyRedacted.startsWith('BRAND_X — قاعة ريماس')).toBe(true);
  });

  it('W-05: the handover code only in the request; masked everywhere else (12 §5.10)', () => {
    const m = buildTemplateMessage({
      catalog: waCatalog(),
      purpose: 'W-05',
      recipient: { to: null, recipient: 'SA.bsuid.1' },
      params: ['125', '482731'],
      secretParams: ['482731'],
      opaque: 'wam:x',
    });
    expect(JSON.stringify(m.request)).toContain('482731');
    expect(m.request.recipient).toBe('SA.bsuid.1');
    expect(m.bodyRedacted).toContain(`رمز التسليم: ${CODE_MASK}`);
    expect(JSON.stringify(m.payloadRedacted)).not.toContain('482731');
    expect(m.bodyRedacted).not.toContain('482731');
  });

  it('the v2 set (V2-050, DEC-555): point_* names, the venue in W-05 and the code still masked', () => {
    const catalog = waCatalog('BRAND_X', { set: 'v2' });
    const m = buildTemplateMessage({
      catalog,
      purpose: 'W-05',
      recipient: { to: '+966551234567', recipient: null },
      params: waTemplateParams(catalog.byId('W-05'), {
        display_number: '125',
        venue_name: 'قاعة ريماس',
        claim_code: '482731',
      }),
      secretParams: ['482731'],
      opaque: 'wam:x',
    });
    expect(m.templateName).toBe('point_vehicle_ready_v2');
    expect(m.request.template).toMatchObject({
      name: 'point_vehicle_ready_v2',
      components: [
        { type: 'body', parameters: ['125', 'قاعة ريماس', '482731'].map((text) => ({ type: 'text', text })) },
      ],
    });
    expect(m.bodyRedacted).toBe(
      `سيارتك رقم 125 جاهزة عند نقطة التسليم في قاعة ريماس.\nرمز التسليم: ${CODE_MASK}\nأعطِ الرمز للسائق عند الاستلام ولا تشاركه مع غيره.`,
    );
    expect(JSON.stringify(m.payloadRedacted)).not.toContain('482731');
  });

  it('session replies: text, no link previews, quoted context', () => {
    const m = buildSessionMessage({
      recipient: { to: '+966551234567', recipient: null },
      text: 'نص',
      contextWamid: 'wamid.X',
      opaque: 'wam:y',
    });
    expect(m.request).toMatchObject({
      type: 'text',
      text: { preview_url: false, body: 'نص' },
      context: { message_id: 'wamid.X' },
    });
    expect(m.kind).toBe('session_text');
  });

  it('opaque ids round-trip; anything else is ignored', () => {
    const id = '0190d2a4-1111-7000-8000-000000000001';
    expect(messageIdFromOpaque(opaqueFor(id))).toBe(id);
    expect(messageIdFromOpaque('other')).toBeNull();
    expect(messageIdFromOpaque(undefined)).toBeNull();
  });
});

describe('12 §5.5 send-time rules', () => {
  const base = (over: Partial<SendFacts> = {}): SendFacts => ({
    now: NOW,
    purpose: 'W-04',
    kind: 'template',
    customer: { id: 'c1', optedOut: false, hasConsent: true, lastInboundAt: at(-60) },
    ticket: {
      status: 'retrieving',
      channel: 'whatsapp',
      customerId: 'c1',
      waLinkStatus: 'linked',
      linkVersion: 1,
      activeCycleId: 'cy1',
      pendingRetrievalAt: null,
    },
    refs: { cycleId: 'cy1' },
    cycle: { closedAt: null, outcome: null, requestedEarly: false, newerExists: false },
    activeCycle: { closedAt: null, requestedEarly: false },
    task: null,
    claimCode: null,
    ...over,
  });
  const ticket = (t: Partial<NonNullable<SendFacts['ticket']>>) => ({ ...base().ticket!, ...t });

  it('opt-out, consent and the 24 h window', () => {
    expect(sendTimeSkipReason(base({ customer: { ...base().customer, optedOut: true } }))).toBe('opted_out');
    expect(sendTimeSkipReason(base({ customer: { ...base().customer, hasConsent: false } }))).toBe(
      'no_consent',
    );
    expect(
      sendTimeSkipReason(
        base({
          purpose: 'W-12',
          kind: 'session',
          customer: { ...base().customer, optedOut: true },
          ticket: null,
        }),
      ),
    ).toBeNull();
    expect(
      sendTimeSkipReason(
        base({
          purpose: 'W-10',
          kind: 'session',
          ticket: null,
          customer: { ...base().customer, lastInboundAt: at(-86_400) },
        }),
      ),
    ).toBe('stale');
    expect(
      sendTimeSkipReason(
        base({
          purpose: 'W-10',
          kind: 'session',
          ticket: null,
          customer: { ...base().customer, hasConsent: false },
        }),
      ),
    ).toBeNull();
  });

  it('W-01: open ticket, same link_version, same customer', () => {
    const w01 = (t: Partial<NonNullable<SendFacts['ticket']>>, lv = 1) =>
      sendTimeSkipReason(
        base({
          purpose: 'W-01',
          ticket: ticket({ status: 'parking', waLinkStatus: 'pending_send', ...t }),
          refs: { linkVersion: lv },
        }),
      );
    expect(w01({})).toBeNull();
    expect(w01({}, 2)).toBe('stale');
    expect(w01({ status: 'voided' })).toBe('stale');
    expect(w01({ customerId: 'other' })).toBe('stale');
    expect(w01({ waLinkStatus: 'failed' })).toBe('stale');
  });

  it('W-02 superseded once the retrieval moved on; W-03 only while assigned_waiting', () => {
    expect(sendTimeSkipReason(base({ purpose: 'W-02', ticket: ticket({ status: 'requested' }) }))).toBeNull();
    expect(sendTimeSkipReason(base({ purpose: 'W-02', ticket: ticket({ status: 'retrieving' }) }))).toBe(
      'superseded',
    );
    expect(
      sendTimeSkipReason(
        base({
          purpose: 'W-03',
          ticket: ticket({ status: 'assigned_waiting' }),
          task: { status: 'assigned_waiting' },
        }),
      ),
    ).toBeNull();
    expect(
      sendTimeSkipReason(
        base({ purpose: 'W-03', ticket: ticket({ status: 'retrieving' }), task: { status: 'in_progress' } }),
      ),
    ).toBe('superseded');
  });

  it('W-04 while retrieving; W-05 never skipped while ready with a live code', () => {
    expect(sendTimeSkipReason(base())).toBeNull();
    expect(sendTimeSkipReason(base({ ticket: ticket({ status: 'ready' }) }))).toBe('superseded');
    const code = { consumedAt: null, revokedAt: null, expiresAt: at(600), hasCiphertext: true };
    const w05 = (over: Partial<SendFacts>) =>
      sendTimeSkipReason(
        base({ purpose: 'W-05', ticket: ticket({ status: 'ready' }), claimCode: code, ...over }),
      );
    expect(w05({})).toBeNull();
    expect(w05({ claimCode: { ...code, revokedAt: at(-1) } })).toBe('superseded');
    expect(w05({ claimCode: { ...code, expiresAt: at(-1) } })).toBe('stale');
    expect(w05({ claimCode: { ...code, hasCiphertext: false } })).toBe('stale');
  });

  it('W-07 / W-08 only without a newer cycle; the ticket must still be linked', () => {
    const closed = { closedAt: at(-5), outcome: 'canceled', requestedEarly: false, newerExists: false };
    expect(
      sendTimeSkipReason(base({ purpose: 'W-07', ticket: ticket({ status: 'parked' }), cycle: closed })),
    ).toBeNull();
    expect(
      sendTimeSkipReason(
        base({
          purpose: 'W-07',
          ticket: ticket({ status: 'requested' }),
          cycle: { ...closed, newerExists: true },
        }),
      ),
    ).toBe('superseded');
    expect(
      sendTimeSkipReason(
        base({
          purpose: 'W-08',
          ticket: ticket({ status: 'reparking' }),
          cycle: { ...closed, outcome: 'reparked' },
        }),
      ),
    ).toBeNull();
    expect(sendTimeSkipReason(base({ ticket: ticket({ waLinkStatus: 'opted_out' }) }))).toBe('opted_out');
    expect(sendTimeSkipReason(base({ ticket: ticket({ waLinkStatus: 'pending_send' }) }))).toBe('stale');
    expect(sendTimeSkipReason(base({ ticket: ticket({ channel: 'paper' }) }))).toBe('stale');
  });

  it('W-09 variant by state', () => {
    expect(w09VariantFor({ status: 'parking', pendingRetrievalAt: at(-1) })).toBe('pending_early');
    expect(w09VariantFor({ status: 'requested', pendingRetrievalAt: null })).toBe('requested');
    expect(w09VariantFor({ status: 'voided', pendingRetrievalAt: null })).toBe('inactive');
    expect(w09VariantFor({ status: 'parked', pendingRetrievalAt: null })).toBeNull();
  });
});
