import { brand } from '../src/catalog.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signWebhookBody, startSimulator, type RunningSimulator } from '../src/index.js';
import {
  graphSend,
  type Receiver,
  SECRET,
  sessionText,
  startReceiver,
  TOKEN,
  value,
  VERIFY_TOKEN,
  w01,
  w05,
} from './helpers.js';

let sim: RunningSimulator;
let hook: Receiver;
const CUS1 = '+966551234567';
const CUS3 = '+966500001234';

beforeAll(async () => {
  hook = await startReceiver();
  sim = await startSimulator({
    appSecret: SECRET,
    accessToken: TOKEN,
    verifyToken: VERIFY_TOKEN,
    autoStatuses: false,
    phoneNumberId: '123456789012345',
  });
});
afterAll(async () => {
  await sim.close();
  await hook.close();
});
beforeEach(async () => {
  await sim.client.reset({ resetConfig: true });
  await sim.client.configure({ webhookUrl: hook.url });
  hook.clear();
});

async function sendW01(
  to = CUS1,
  ticket = '125',
  token = `rq1.token-${ticket}`,
  venue = 'قاعة ريماس',
): Promise<string> {
  const res = await graphSend(sim.url, w01(to, ticket, token, venue));
  expect(res.status).toBe(200);
  return res.json.messages[0].id as string;
}

describe('button press webhook', () => {
  it('carries the payload of the sent W-01, context.id and a valid signature over the raw body', async () => {
    const wamid = await sendW01();
    const result = await sim.client.pressButton({ to: CUS1 });
    expect(result.deliveries).toEqual([
      expect.objectContaining({ kind: 'button', httpStatus: 200, ok: true, signature: 'valid' }),
    ]);

    const [got] = await hook.waitFor(1);
    expect(got!.signatureValid).toBe(true);
    expect(got!.headers['x-hub-signature-256']).toBe(signWebhookBody(SECRET, got!.raw));
    expect(got!.headers['content-type']).toBe('application/json');
    expect(got!.json).toEqual({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '200000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '966500000000', phone_number_id: '123456789012345' },
                contacts: [
                  {
                    profile: { name: expect.any(String) },
                    wa_id: '966551234567',
                    user_id: expect.stringMatching(/^SA\./),
                  },
                ],
                messages: [
                  {
                    context: { from: '966500000000', id: wamid },
                    from: '966551234567',
                    from_user_id: expect.stringMatching(/^SA\./),
                    id: result.wamids[0],
                    timestamp: expect.stringMatching(/^\d{10}$/),
                    type: 'button',
                    button: { payload: 'rq1.token-125', text: 'طلب السيارة' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  });

  it('can come from another number with the same payload (AC-02 forwarded)', async () => {
    await sendW01(CUS1);
    const r = await sim.client.runScenario('forwarded', { to: CUS1 });
    const [got] = await hook.waitFor(1);
    const m = value(got!).messages[0];
    expect(`+${m.from}`).toBe(CUS3); // default forwarding sender = CUS3 of the test seed
    expect(m.button.payload).toBe('rq1.token-125');
    expect(r.deliveries).toHaveLength(1);
  });

  it('presses the intended one of two tickets of the same number (AC-03)', async () => {
    const first = await sendW01(CUS1, '125');
    await sendW01(CUS1, '126');
    await sim.client.pressButton({ to: CUS1, ticketNumber: '125' });
    await sim.client.runScenario('two_tickets', { to: CUS1 }); // default: latest ticket
    const [a, b] = await hook.waitFor(2);
    expect(value(a!).messages[0]).toMatchObject({
      context: { id: first },
      button: { payload: 'rq1.token-125' },
    });
    expect(value(b!).messages[0].button.payload).toBe('rq1.token-126');
  });

  it('one number, two venues: every W-01 comes from the single phone_number_id and each can be pressed (AC-20)', async () => {
    await sendW01(CUS1, '125', 'rq1.rms', 'قاعة ريماس');
    await sendW01(CUS1, '301', 'rq1.lyl', 'قاعة ليلتي');
    const sent = await sim.client.listMessages({ to: CUS1, purpose: 'W-01' });
    expect(new Set(sent.map((m) => m.phoneNumberId))).toEqual(new Set(['123456789012345']));
    expect(sent[1]?.renderedText).toContain('قاعة ليلتي');
    await sim.client.runScenario('two_venues', { to: CUS1 });
    const got = await hook.waitFor(2);
    expect(got.map((g) => value(g).messages[0].button.payload)).toEqual(['rq1.rms', 'rq1.lyl']);
  });

  it('supports forged payloads and a missing context (unknown-token tests)', async () => {
    await sendW01();
    await sim.client.pressButton({ to: CUS1, payloadOverride: 'rq1.forged', omitContext: true });
    const [got] = await hook.waitFor(1);
    expect(value(got!).messages[0]).not.toHaveProperty('context');
    expect(value(got!).messages[0].button.payload).toBe('rq1.forged');
  });

  it('404s when the number has no message with a button', async () => {
    await graphSend(sim.url, w05(CUS1));
    await expect(sim.client.pressButton({ to: CUS1 })).rejects.toMatchObject({
      status: 404,
      code: 'message_not_found',
    });
  });
});

describe('duplicates (AC-01)', () => {
  it('same_body: byte-identical bodies, one inbound message', async () => {
    await sendW01();
    const r = await sim.client.pressButton({ to: CUS1, copies: 10, parallel: 5 });
    expect(r.deliveries).toHaveLength(10);
    expect(new Set(r.deliveries.map((d) => d.bodySha256)).size).toBe(1);
    const got = await hook.waitFor(10);
    expect(new Set(got.map((g) => g.raw)).size).toBe(1);
    expect(got.every((g) => g.signatureValid)).toBe(true);
    expect((await sim.client.conversation(CUS1)).inbound).toBe(1);
  });

  it('same_wamid: one wamid in ten different raw bodies, all correctly signed', async () => {
    await sendW01();
    const r = await sim.client.pressButton({ to: CUS1, copies: 10, duplicateMode: 'same_wamid' });
    const got = await hook.waitFor(10);
    expect(new Set(got.map((g) => g.raw)).size).toBe(10);
    expect(new Set(got.map((g) => value(g).messages[0].id))).toEqual(new Set(r.wamids));
    expect(got.every((g) => g.signatureValid)).toBe(true);
  });

  it('distinct (taps10): ten different wamids', async () => {
    await sendW01();
    const r = await sim.client.runScenario('taps10', { to: CUS1, spreadMs: 50 });
    expect(new Set(r.wamids).size).toBe(10);
    await hook.waitFor(10);
    expect((await sim.client.conversation(CUS1)).inbound).toBe(10);
  });

  it('dup10: ten identical bodies, then the same wamid in ten different bodies', async () => {
    await sendW01();
    const r = await sim.client.runScenario('dup10', { to: CUS1 });
    expect(r.deliveries).toHaveLength(20);
    expect(new Set(r.wamids).size).toBe(1);
    const shas = r.deliveries.map((d) => d.bodySha256);
    expect(new Set(shas.slice(0, 10)).size).toBe(1);
    expect(new Set(shas.slice(10)).size).toBe(10);
    expect(shas.slice(10)).not.toContain(shas[0]);
  });
});

describe('status webhooks', () => {
  const order = async (o: 'natural' | 'reversed' | 'duplicated' | 'reorder') => {
    const wamid = await sendW01();
    hook.clear();
    await sim.client.emitStatuses({ wamid, order: o });
    const got = await hook.received;
    return got.map((g) => value(g).statuses[0].status as string);
  };

  it.each([
    ['natural', ['sent', 'delivered', 'read']],
    ['reversed', ['read', 'delivered', 'sent']],
    ['duplicated', ['sent', 'sent', 'delivered', 'delivered', 'read', 'read']],
    ['reorder', ['read', 'sent', 'delivered']],
  ] as const)('%s order', async (o, expected) => {
    expect(await order(o)).toEqual(expected);
  });

  it('duplicated statuses are byte-identical; pricing only on sent; opaque data echoed', async () => {
    const wamid = await sendW01();
    await sim.client.emitStatuses({ wamid, order: 'duplicated' });
    const got = hook.received;
    expect(got[0]!.raw).toBe(got[1]!.raw);
    const [sent, , delivered] = got.map((g) => value(g).statuses[0]);
    expect(sent).toMatchObject({
      id: wamid,
      recipient_id: '966551234567',
      biz_opaque_callback_data: 'wam:125',
      pricing: { billable: true, pricing_model: 'PMP', category: 'utility', type: 'regular' },
    });
    expect(delivered).not.toHaveProperty('pricing');
    expect((await sim.client.conversation(CUS1)).items[0]?.status).toBe('read');
  });

  it('failed status with an error code; read keeps the display status (rank never drops)', async () => {
    const wamid = await sendW01();
    await sim.client.emitStatuses({ wamid, statuses: ['read'] });
    await sim.client.emitStatuses({ wamid, statuses: ['failed'], errorCode: 131049 });
    const s = value(hook.received[1]!).statuses[0];
    expect(s).toMatchObject({ status: 'failed', errors: [{ code: 131049 }] });
    expect((await sim.client.conversation(CUS1)).items[0]?.status).toBe('read');
  });

  it('auto statuses: sent → delivered → read after each accepted send', async () => {
    await sim.client.configure({ autoStatuses: true, statusDelayMs: 5 });
    const wamid = await sendW01();
    const got = await hook.waitFor(3);
    expect(got.map((g) => [value(g).statuses[0].id, value(g).statuses[0].status])).toEqual([
      [wamid, 'sent'],
      [wamid, 'delivered'],
      [wamid, 'read'],
    ]);
    expect(got.every((g) => g.signatureValid)).toBe(true);
  });

  it('auto statuses honour the configured order, and crash_after_accept delays them', async () => {
    await sim.client.configure({ autoStatuses: true, statusDelayMs: 5, statusOrder: 'reversed' });
    await sim.client.runScenario('crash_after_accept', { delayMs: 300 });
    const started = Date.now();
    await sendW01();
    const [first] = await hook.waitFor(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(value(first!).statuses[0].status).toBe('read');
  });

  it('reset stops pending auto statuses', async () => {
    await sim.client.configure({ autoStatuses: true, statusDelayMs: 40 });
    await sendW01();
    await sim.client.reset();
    await new Promise((r) => setTimeout(r, 200));
    expect(hook.received).toHaveLength(0);
    expect(await sim.client.webhookDeliveries()).toEqual([]);
  });
});

describe('inbound text, link code, stop, interactive, signature modes', () => {
  it('free text, the QR link-code text and the stop keyword', async () => {
    await sim.client.sendText({ from: CUS1, body: 'وين سيارتي؟' });
    await sim.client.sendLinkCode(CUS1, 'K7Q29F');
    await sim.client.sendStop(CUS1);
    const got = await hook.waitFor(3);
    expect(got.map((g) => value(g).messages[0].text.body)).toEqual([
      'وين سيارتي؟',
      `ربط تذكرة ${brand().customerNameAr} K7Q29F`,
      'إيقاف',
    ]);
    expect(value(got[0]!).messages[0]).toMatchObject({ from: '966551234567', type: 'text' });
  });

  it('qr_race: two numbers send the same code', async () => {
    await sim.client.runScenario('qr_race', { from: CUS1, from2: '+966559876543', code: 'K7Q29F' });
    const got = await hook.waitFor(2);
    expect(got.map((g) => value(g).messages[0].from)).toEqual(['966551234567', '966559876543']);
  });

  it('a BSUID-only user (no phone in the webhook)', async () => {
    await sim.client.sendText({ from: CUS1, body: 'ربط K7Q29F', bsuidOnly: true });
    const [got] = await hook.waitFor(1);
    const v = value(got!);
    expect(v.contacts[0]).toEqual({
      profile: { name: expect.any(String) },
      user_id: expect.stringMatching(/^SA\./),
    });
    expect(v.messages[0]).not.toHaveProperty('from');
  });

  it('interactive button_reply', async () => {
    await sim.client.sendInteractive({ from: CUS1, id: 'x1', title: 'نعم' });
    const [got] = await hook.waitFor(1);
    expect(value(got!).messages[0]).toMatchObject({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'x1', title: 'نعم' } },
    });
  });

  it('invalid and missing signatures (TC-WA-13)', async () => {
    await sim.client.sendText({ from: CUS1, body: 'a', signature: 'invalid' });
    await sim.client.sendText({ from: CUS1, body: 'b', signature: 'missing' });
    const [bad, none] = await hook.waitFor(2);
    expect(bad!.signatureValid).toBe(false);
    expect(bad!.headers['x-hub-signature-256']).toMatch(/^sha256=/);
    expect(none!.headers).not.toHaveProperty('x-hub-signature-256');
  });

  it('raw bodies are signed exactly as given', async () => {
    const raw = '{"object":"whatsapp_business_account","entry":[]}';
    await sim.client.emitRaw({ body: raw, copies: 3, parallel: 3 });
    const got = await hook.waitFor(3);
    expect(got.every((g) => g.raw === raw && g.signatureValid)).toBe(true);
  });

  it('records non-2xx answers and retries when configured', async () => {
    await sim.client.configure({ webhookRetries: 2, webhookRetryDelayMs: 5 });
    hook.failNext(500, 503);
    const r = await sim.client.sendText({ from: CUS1, body: 'x' });
    expect(r.deliveries[0]).toMatchObject({ attempts: 3, httpStatus: 200, ok: true });
    await sim.client.configure({ webhookRetries: 0 });
    hook.failNext(401);
    const r2 = await sim.client.sendText({ from: CUS1, body: 'y', signature: 'invalid' });
    expect(r2.deliveries[0]).toMatchObject({ attempts: 1, httpStatus: 401, ok: false });
    expect((await sim.client.webhookDeliveries()).length).toBe(2);
  });

  it('409 when no webhook URL is configured', async () => {
    await sim.client.configure({ webhookUrl: null });
    await expect(sim.client.sendText({ from: CUS1, body: 'x' })).rejects.toMatchObject({
      status: 409,
      code: 'webhook_url_not_configured',
    });
  });

  it('performs the GET verification handshake', async () => {
    expect(await sim.client.verifyWebhook()).toMatchObject({ ok: true, httpStatus: 200 });
    expect(await sim.client.verifyWebhook({ verifyToken: 'wrong' })).toMatchObject({
      ok: false,
      httpStatus: 403,
    });
  });
});

describe('claim codes, conversations, scenario files, UI', () => {
  it('extracts the handover code of the last W-05 (template or session-text fallback)', async () => {
    expect(await sim.client.claimCode(CUS1)).toBeNull();
    await graphSend(sim.url, w05(CUS1, '125', '482731'));
    expect(await sim.client.claimCodeDetails(CUS1)).toMatchObject({
      code: '482731',
      ticketNumber: '125',
      source: 'template',
    });
    await graphSend(
      sim.url,
      sessionText(
        CUS1,
        'سيارتك رقم 125 جاهزة عند نقطة التسليم.\nرمز التسليم: 905113\nأعطِ الرمز للسائق عند الاستلام ولا تشاركه مع غيره.',
      ),
    );
    expect(await sim.client.claimCodeDetails(CUS1)).toMatchObject({
      code: '905113',
      ticketNumber: '125',
      source: 'text',
    });
  });

  it('builds the conversation as the customer sees it', async () => {
    await sendW01();
    await sim.client.tap(CUS1);
    await graphSend(sim.url, w05(CUS1));
    const conv = await sim.client.conversation(CUS1);
    expect(conv.items.map((i) => [i.direction, i.purpose ?? i.kind])).toEqual([
      ['out', 'W-01'],
      ['in', 'button'],
      ['out', 'W-05'],
    ]);
    expect(conv.items[2]?.claimCode).toBe('482731');
    expect((await sim.client.conversations()).map((c) => c.key)).toEqual(['966551234567']);
  });

  it('replays a scenario file', async () => {
    await sendW01();
    const r = await sim.client.runScenarioFile(
      new URL('../scenarios/ac01-duplicate-press.json', import.meta.url),
    );
    expect(r.deliveries.length).toBe(16);
    expect(r.deliveries.every((d) => d.httpStatus === 200)).toBe(true);
    expect(r.steps.map((s) => s.action)).toEqual(['press', 'wait', 'press', 'statuses']);
  });

  it('serves the RTL Arabic dev page', async () => {
    const res = await fetch(`${sim.url}/`);
    const html = await res.text();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<html lang="ar" dir="rtl">');
    // the customer brand from configuration (canon §1; «بوينت» by default since V2-D01, DEC-470)
    expect(html).toContain(brand().customerNameAr);
  });

  it('answers the spec aliases under /sim/* too', async () => {
    await sendW01();
    const res = await fetch(`${sim.url}/sim/customers/${encodeURIComponent(CUS1)}/tap`, { method: 'POST' });
    expect(res.status).toBe(200);
    const conv = (await (await fetch(`${sim.url}/sim/conversations/966551234567`)).json()) as any;
    expect(conv.items).toHaveLength(2);
  });
});
