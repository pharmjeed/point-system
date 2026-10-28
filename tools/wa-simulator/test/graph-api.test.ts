import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startSimulator, type RunningSimulator } from '../src/index.js';
import { graphSend, SECRET, sessionText, TOKEN, w01, w05 } from './helpers.js';

let sim: RunningSimulator;

beforeAll(async () => {
  sim = await startSimulator({ appSecret: SECRET, accessToken: TOKEN, autoStatuses: false });
});
afterAll(() => sim.close());
beforeEach(() => sim.client.reset({ resetConfig: true }));

describe('POST /{version}/{phone_number_id}/messages', () => {
  it('accepts the W-01 template and answers like Graph', async () => {
    const res = await graphSend(sim.url, w01('+966551234567'));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      messaging_product: 'whatsapp',
      contacts: [{ input: '+966551234567', wa_id: '966551234567' }],
      messages: [{ id: expect.stringMatching(/^wamid\.SIM\.[0-9a-f-]{36}$/), message_status: 'accepted' }],
    });

    const stored = await sim.client.getMessage(res.json.messages[0].id);
    expect(stored).toMatchObject({
      apiVersion: 'v26.0',
      phoneNumberId: '123456789012345',
      waId: '966551234567',
      type: 'template',
      templateName: 'masaf_ticket_issued_v1',
      purpose: 'W-01',
      bodyParams: ['قاعة ريماس', '125', 'تويوتا كامري بيضاء — لوحة 4821'],
      buttons: [
        { index: 0, subType: 'quick_reply', payload: 'rq1.q8Zt3mVx0bW7nK2pLs9dEw', text: 'طلب السيارة' },
      ],
      bizOpaqueCallbackData: 'wam:125',
      plannedFailure: null,
    });
    expect(stored.renderedText).toBe(
      'مصاف — قاعة ريماس — تذكرة 125\nتم استلام مركبتك: تويوتا كامري بيضاء — لوحة 4821.\nعند رغبتك بالخروج اضغط «طلب السيارة».',
    );
    expect(stored.userId).toMatch(/^SA\.\d{20}$/);
    expect((await sim.client.lastMessage('966551234567'))?.wamid).toBe(stored.wamid);
  });

  it('accepts a session text reply (no message_status) and records it', async () => {
    const res = await graphSend(sim.url, sessionText('+966551234567', 'مرحبًا بك'));
    expect(res.status).toBe(200);
    expect(res.json.messages[0]).toEqual({ id: expect.stringMatching(/^wamid\.SIM\./) });
    const [msg] = await sim.client.listMessages({ to: '+966551234567', type: 'text' });
    expect(msg?.text).toBe('مرحبًا بك');
  });

  it('sends to a BSUID with `recipient` (DEC-35)', async () => {
    const res = await graphSend(sim.url, {
      ...sessionText('x', 'hi'),
      to: undefined,
      recipient: 'SA.12345678901234567890',
    });
    expect(res.status).toBe(200);
    expect(res.json.contacts).toEqual([
      { input: 'SA.12345678901234567890', user_id: 'SA.12345678901234567890' },
    ]);
  });

  it('filters stored messages by recipient and template', async () => {
    await graphSend(sim.url, w01('+966551234567', '125'));
    await graphSend(sim.url, w05('+966551234567', '125'));
    await graphSend(sim.url, w01('+966559876543', '126'));
    expect(await sim.client.listMessages({ to: '+966551234567' })).toHaveLength(2);
    expect(await sim.client.listMessages({ template: 'masaf_ticket_issued_v1' })).toHaveLength(2);
    expect(await sim.client.listMessages({ purpose: 'W-05' })).toHaveLength(1);
    const last = await sim.client.lastMessage('+966551234567', { template: 'masaf_ticket_issued_v1' });
    expect(last?.bodyParams[1]).toBe('125');
    expect(await sim.client.lastMessage('+966500000099')).toBeNull();
  });

  it.each([
    ['missing messaging_product', { ...w01('+966551234567'), messaging_product: undefined }, 400, 100],
    ['missing to', { ...w01('+966551234567'), to: undefined }, 400, 100],
    ['unknown type', { ...sessionText('+966551234567', 'x'), type: 'carousel' }, 400, 100],
    ['empty text body', sessionText('+966551234567', ''), 400, 100],
    ['text over 4096 chars', sessionText('+966551234567', 'x'.repeat(4097)), 400, 100],
    [
      'unknown template',
      { ...w01('+966551234567'), template: { name: 'masaf_nope_v1', language: { code: 'ar' } } },
      404,
      132001,
    ],
    [
      'wrong language',
      { ...w01('+966551234567'), template: { ...w01('').template, language: { code: 'en' } } },
      404,
      132001,
    ],
    [
      'body parameter count mismatch',
      {
        ...w05('+966551234567'),
        template: {
          ...w05('').template,
          components: [{ type: 'body', parameters: [{ type: 'text', text: '1' }] }],
        },
      },
      400,
      132000,
    ],
    [
      'newline inside a parameter',
      {
        ...w05('+966551234567'),
        template: {
          ...w05('').template,
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: '1\n2' },
                { type: 'text', text: '3' },
              ],
            },
          ],
        },
      },
      400,
      100,
    ],
    [
      'button on a template without buttons',
      {
        ...w05('+966551234567'),
        template: {
          ...w05('').template,
          components: [
            ...w05('').template.components,
            {
              type: 'button',
              sub_type: 'quick_reply',
              index: '0',
              parameters: [{ type: 'payload', payload: 'x' }],
            },
          ],
        },
      },
      400,
      131009,
    ],
    [
      'quick reply without payload',
      {
        ...w01('+966551234567'),
        template: {
          ...w01('').template,
          components: [
            w01('').template.components[0],
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [] },
          ],
        },
      },
      400,
      131008,
    ],
  ])('rejects %s like Meta', async (_name, body, status, code) => {
    const res = await graphSend(sim.url, body);
    expect(res.status).toBe(status);
    expect(res.json.error).toMatchObject({ code, type: 'OAuthException', fbtrace_id: expect.any(String) });
    expect(res.json.error.message).toContain(`#${code}`);
    expect(await sim.client.listMessages()).toHaveLength(0);
  });

  it('checks the bearer token (190) and, when configured, the phone_number_id (100)', async () => {
    let res = await graphSend(sim.url, w01('+966551234567'), { token: null });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe(190);
    res = await graphSend(sim.url, w01('+966551234567'), { token: 'wrong' });
    expect(res.status).toBe(401);

    await sim.client.configure({ phoneNumberId: '999' });
    res = await graphSend(sim.url, w01('+966551234567'));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 100, error_subcode: 33 });
    res = await graphSend(sim.url, w01('+966551234567'), { phoneNumberId: '999' });
    expect(res.status).toBe(200);
  });

  it('refuses templates that are not APPROVED (paused → 132015)', async () => {
    await sim.client.setTemplateStatus('masaf_vehicle_ready_v1', 'PAUSED');
    let res = await graphSend(sim.url, w05('+966551234567'));
    expect(res.json.error.code).toBe(132015);
    await sim.client.setTemplateStatus('masaf_vehicle_ready_v1', 'REJECTED');
    res = await graphSend(sim.url, w05('+966551234567'));
    expect(res.json.error.code).toBe(132001);
    await sim.client.reset();
    expect((await graphSend(sim.url, w05('+966551234567'))).status).toBe(200);
  });

  it('rejects an unversioned path', async () => {
    const res = await graphSend(sim.url, w01('+966551234567'), { version: 'latest' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe(2500);
  });
});

describe('other Graph routes', () => {
  it('GET /{version}/{phone_number_id} reports the number for the health check', async () => {
    const res = await fetch(`${sim.url}/v26.0/123456789012345`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: '123456789012345',
      verified_name: 'مصاف',
      quality_rating: 'GREEN',
      health_status: { can_send_message: 'AVAILABLE' },
    });
  });

  it('lists the local catalog and creates templates (APPROVED, or REJECTED by the test rule)', async () => {
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const list = (await (
      await fetch(`${sim.url}/v26.0/200000000000001/message_templates`, { headers: auth })
    ).json()) as any;
    expect(list.data.map((t: any) => t.name)).toEqual([
      'masaf_ticket_issued_v1',
      'masaf_request_received_v1',
      'masaf_request_reserved_v1',
      'masaf_retrieval_started_v1',
      'masaf_vehicle_ready_v1',
      'masaf_vehicle_delivered_v1',
      'masaf_request_canceled_v1',
      'masaf_returned_to_parking_v1',
    ]);
    expect(list.data[0]).toMatchObject({
      status: 'APPROVED',
      category: 'UTILITY',
      language: 'ar',
      components: [
        { type: 'BODY' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'طلب السيارة' }] },
      ],
    });
    for (const t of list.data.slice(1)) expect(t.components).toHaveLength(1);

    const create = (name: string) =>
      fetch(`${sim.url}/v26.0/200000000000001/message_templates`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name,
          language: 'ar',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'سيارتك رقم {{1}} جاهزة.', example: { body_text: [['125']] } }],
        }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
    const ok = await create('masaf_vehicle_ready_v2');
    expect(ok).toMatchObject({
      status: 200,
      json: { status: 'APPROVED', category: 'UTILITY', id: expect.any(String) },
    });
    expect((await create('masaf_vehicle_ready_v2')).status).toBe(400); // already exists
    expect((await create('promo_rejected_v1')).json.status).toBe('REJECTED');
    const res = await graphSend(sim.url, {
      ...w05('+966551234567'),
      template: {
        name: 'masaf_vehicle_ready_v2',
        language: { code: 'ar' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: '125' }] }],
      },
    });
    expect(res.status).toBe(200);
    expect((await sim.client.getMessage(res.json.messages[0].id)).purpose).toBe('W-05');
  });
});
