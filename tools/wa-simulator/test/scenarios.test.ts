import { brand } from '../src/catalog.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_SCENARIOS, startSimulator, type RunningSimulator } from '../src/index.js';
import { graphSend, type Receiver, SECRET, startReceiver, TOKEN, value, w01 } from './helpers.js';

let sim: RunningSimulator;
let hook: Receiver;
const CUS1 = '+966551234567';

beforeAll(async () => {
  hook = await startReceiver();
  sim = await startSimulator({ appSecret: SECRET, accessToken: TOKEN, autoStatuses: false });
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

describe('built-in scenarios (docs/12 §11.4)', () => {
  it('lists every scenario of the spec', async () => {
    expect(await sim.client.scenarios()).toEqual([...BUILTIN_SCENARIOS]);
    expect(BUILTIN_SCENARIOS).toEqual(
      expect.arrayContaining([
        'dup10',
        'taps10',
        'reorder',
        'forwarded',
        'two_tickets',
        'two_venues',
        'qr_link',
        'qr_race',
        'opt_out_then_tap',
        'channel_down',
        'crash_after_accept',
      ]),
    );
  });

  it('opt_out_then_tap: the stop keyword, then a press of the latest W-01', async () => {
    await graphSend(sim.url, w01(CUS1));
    const r = await sim.client.runScenario('opt_out_then_tap', { to: CUS1 });
    expect(r.steps.map((s) => s.action)).toEqual(['stop', 'wait', 'press']);
    const got = await hook.waitFor(2);
    expect(value(got[0]!).messages[0].text.body).toBe('إيقاف');
    expect(value(got[1]!).messages[0].type).toBe('button');
  });

  it('qr_link sends the prefilled text', async () => {
    await sim.client.runScenario('qr_link', { from: '+966552222222', code: 'K7Q29F' });
    const [got] = await hook.waitFor(1);
    const m = value(got!).messages[0];
    expect(m.text.body).toBe(`ربط تذكرة ${brand().customerNameAr} K7Q29F`);
    expect(m).not.toHaveProperty('from'); // …2222 = BSUID-only user (TC-WA-23)
  });

  it('reorder: read before sent, delivered after read', async () => {
    const res = await graphSend(sim.url, w01(CUS1));
    await sim.client.runScenario('reorder', { wamid: res.json.messages[0].id });
    expect(hook.received.map((g) => value(g).statuses[0].status)).toEqual(['read', 'sent', 'delivered']);
  });

  it('reports which step failed', async () => {
    await expect(sim.client.runScenario('two_tickets', { to: CUS1 })).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('scenario two_tickets, step 0 (press)'),
    });
    await expect(sim.client.runScenario('nope')).rejects.toMatchObject({
      status: 404,
      code: 'unknown_scenario',
    });
    await expect(
      sim.client.runScenarioDocument({ steps: [{ action: 'jump' } as never] }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('scenario documents can inject faults and nest built-ins', async () => {
    const r = await sim.client.runScenarioDocument({
      name: 'faults',
      steps: [
        { action: 'fault', code: 131000, count: 2 },
        { action: 'latency', ms: 0 },
        { action: 'channel', state: 'up' },
        { action: 'scenario', name: 'qr_link', params: { from: CUS1, code: 'ABC234' } },
      ],
    });
    expect(r.deliveries).toHaveLength(1);
    expect((await sim.client.faults()).rules[0]).toMatchObject({ code: 131000, remaining: 2 });
    expect((await graphSend(sim.url, w01(CUS1))).json.error.code).toBe(131000);
  });
});

describe('control API validation and template webhooks', () => {
  it('rejects unknown config keys and bad fault rules', async () => {
    await expect(sim.client.configure({ webhookUrll: 'x' } as never)).rejects.toMatchObject({ status: 400 });
    await expect(sim.client.configure({ statusOrder: 'up' as never })).rejects.toMatchObject({ status: 400 });
    await expect(sim.client.addFault({})).rejects.toMatchObject({ status: 400, code: 'invalid_fault' });
    await expect(sim.client.addFault({ code: 131056, count: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it('emits message_template_status_update when a template status changes', async () => {
    await sim.client.setTemplateStatus('masaf_vehicle_ready_v1', 'PAUSED', { emitWebhook: true });
    const [got] = await hook.waitFor(1);
    expect(got!.signatureValid).toBe(true);
    expect(got!.json.entry[0].changes[0]).toMatchObject({
      field: 'message_template_status_update',
      value: {
        event: 'PAUSED',
        message_template_name: 'masaf_vehicle_ready_v1',
        message_template_language: 'ar',
      },
    });
  });

  it('approves created templates after the configured delay', async () => {
    await sim.client.configure({ templateApprovalDelayMs: 30 });
    const res = await fetch(`${sim.url}/v26.0/200000000000001/message_templates`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'masaf_x_v1',
        language: 'ar',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'نص ثابت.' }],
      }),
    });
    expect(((await res.json()) as any).status).toBe('PENDING');
    const [got] = await hook.waitFor(1);
    expect(got!.json.entry[0].changes[0].value).toMatchObject({
      event: 'APPROVED',
      message_template_name: 'masaf_x_v1',
    });
    expect((await sim.client.templates()).find((t) => t.name === 'masaf_x_v1')?.status).toBe('APPROVED');
  });

  it('reset clears messages, inbound, deliveries and faults', async () => {
    await graphSend(sim.url, w01(CUS1));
    await sim.client.tap(CUS1);
    await sim.client.addFault({ code: 131056 });
    await sim.client.reset();
    expect(await sim.client.listMessages()).toEqual([]);
    expect(await sim.client.conversations()).toEqual([]);
    expect(await sim.client.webhookDeliveries()).toEqual([]);
    expect((await sim.client.faults()).rules).toEqual([]);
    expect((await sim.client.getConfig()).webhookUrl).toBe(hook.url); // config kept
  });
});
