import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { graphErrorInfo, RETRYABLE_CODES, startSimulator, type RunningSimulator } from '../src/index.js';
import {
  graphSend,
  type Receiver,
  SECRET,
  sessionText,
  startReceiver,
  TOKEN,
  value,
  w01,
  w05,
} from './helpers.js';

let sim: RunningSimulator;
let hook: Receiver;

beforeAll(async () => {
  hook = await startReceiver();
  sim = await startSimulator({ appSecret: SECRET, accessToken: TOKEN, autoStatuses: false, hangMs: 2000 });
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

describe('fault injection through the control API', () => {
  it('fails the next send with a retryable Graph error, then recovers', async () => {
    await sim.client.addFault({ code: 131056 });
    const first = await graphSend(sim.url, w01('+966551234567'));
    expect(first.status).toBe(400);
    expect(first.json.error).toMatchObject({ code: 131056, error_data: { messaging_product: 'whatsapp' } });
    expect((await graphSend(sim.url, w01('+966551234567'))).status).toBe(200);
    expect(graphErrorInfo(131056).retryable).toBe(true);
    expect(RETRYABLE_CODES).toEqual(expect.arrayContaining([130429, 131056, 131000, 131016]));
  });

  it('counts uses, matches by recipient/template and logs every attempt', async () => {
    await sim.client.addFault({ code: 130429, count: 2, match: { template: 'masaf_vehicle_ready_v1' } });
    expect((await graphSend(sim.url, w01('+966551234567'))).status).toBe(200); // other template: untouched
    expect((await graphSend(sim.url, w05('+966551234567'))).json.error.code).toBe(130429);
    expect((await graphSend(sim.url, w05('+966551234567'))).json.error.code).toBe(130429);
    expect((await graphSend(sim.url, w05('+966551234567'))).status).toBe(200);
    const attempts = await sim.client.sendAttempts();
    expect(attempts.map((a) => [a.templateName, a.httpStatus, a.errorCode, a.cause])).toEqual([
      ['masaf_ticket_issued_v1', 200, null, null],
      ['masaf_vehicle_ready_v1', 400, 130429, 'fault'],
      ['masaf_vehicle_ready_v1', 400, 130429, 'fault'],
      ['masaf_vehicle_ready_v1', 200, null, null],
    ]);
    expect((await sim.client.faults()).rules[0]).toMatchObject({ remaining: 0, hits: 2 });
  });

  it('answers permanent errors (132001 with HTTP 404, 131026 sync)', async () => {
    await sim.client.addFaults([{ code: 132001 }, { code: 131026, match: { to: '+966559876543' } }]);
    const a = await graphSend(sim.url, w01('+966551234567'));
    expect([a.status, a.json.error.code]).toEqual([404, 132001]);
    const b = await graphSend(sim.url, w01('+966559876543'));
    expect([b.status, b.json.error.code]).toEqual([400, 131026]);
    expect(graphErrorInfo(131026).retryable).toBe(false);
  });

  it('async mode accepts the send, then emits a signed `failed` status with the error code', async () => {
    await sim.client.configure({ autoStatuses: true, statusDelayMs: 5 });
    await sim.client.addFault({ code: 131026, mode: 'async' });
    const res = await graphSend(sim.url, w01('+966551234567'));
    expect(res.status).toBe(200);
    const [got] = await hook.waitFor(1);
    expect(got?.signatureValid).toBe(true);
    expect(value(got!).statuses).toEqual([
      expect.objectContaining({
        id: res.json.messages[0].id,
        status: 'failed',
        recipient_id: '966551234567',
        biz_opaque_callback_data: 'wam:125',
        errors: [expect.objectContaining({ code: 131026, title: 'Message undeliverable' })],
      }),
    ]);
  });

  it('bare 5xx answers until the faults are cleared', async () => {
    await sim.client.addFault({ httpStatus: 503, count: 'unlimited' });
    for (let i = 0; i < 3; i++) expect((await graphSend(sim.url, w01('+966551234567'))).status).toBe(503);
    await sim.client.clearFaults();
    expect((await graphSend(sim.url, w01('+966551234567'))).status).toBe(200);
  });

  it('channel down fails every Graph call, and recovers after durationMs', async () => {
    await sim.client.setChannel({ state: 'down', durationMs: 150 });
    const res = await graphSend(sim.url, w01('+966551234567'));
    expect([res.status, res.json.error.code]).toEqual([503, 131016]);
    const health = await fetch(`${sim.url}/v26.0/123`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(503);
    await new Promise((r) => setTimeout(r, 200));
    expect((await graphSend(sim.url, w01('+966551234567'))).status).toBe(200);
  });

  it('channel_down scenario answers 190 (token expired) until recovery', async () => {
    await sim.client.runScenario('channel_down', { durationMs: 60_000 });
    const res = await graphSend(sim.url, w01('+966551234567'));
    expect([res.status, res.json.error.code]).toEqual([401, 190]);
    await sim.client.setChannel({ state: 'up' });
    expect((await graphSend(sim.url, w01('+966551234567'))).status).toBe(200);
  });

  it('timeout mode holds the request without answering', async () => {
    await sim.client.setChannel({ state: 'timeout' });
    const started = Date.now();
    await expect(
      fetch(`${sim.url}/v26.0/123/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(w01('+966551234567')),
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(await sim.client.listMessages()).toHaveLength(0);
  });

  it('adds latency to every Graph call', async () => {
    await sim.client.setLatency(120);
    const started = Date.now();
    expect((await graphSend(sim.url, w01('+966551234567'))).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('honours the X-Sim-Fault header', async () => {
    const res = await graphSend(sim.url, w01('+966551234567'), { headers: { 'x-sim-fault': '130429' } });
    expect(res.json.error.code).toBe(130429);
    const bare = await graphSend(sim.url, w01('+966551234567'), { headers: { 'x-sim-fault': 'http_502' } });
    expect(bare.status).toBe(502);
  });
});

describe('deterministic number rules (docs/12 §11.3)', () => {
  it('…0000 is accepted, then fails with 131026', async () => {
    await sim.client.configure({ autoStatuses: true, statusDelayMs: 5 });
    const res = await graphSend(sim.url, w01('+966550000000'));
    expect(res.status).toBe(200);
    const [got] = await hook.waitFor(1);
    expect(value(got!).statuses[0]).toMatchObject({ status: 'failed', errors: [{ code: 131026 }] });
    expect((await sim.client.getMessage(res.json.messages[0].id)).plannedFailure).toEqual({ code: 131026 });
  });

  it('…1111 fails the first attempt of each message with 131056, then succeeds on retry', async () => {
    const first = await graphSend(sim.url, w01('+966551111111', '125'));
    expect(first.json.error.code).toBe(131056);
    expect((await graphSend(sim.url, w01('+966551111111', '125'))).status).toBe(200); // retry of the same message
    expect((await graphSend(sim.url, w05('+966551111111', '125'))).json.error.code).toBe(131056); // next message
    expect((await graphSend(sim.url, w05('+966551111111', '125'))).status).toBe(200);
  });

  it('…2222 webhooks carry only the BSUID (no from / wa_id / recipient_id)', async () => {
    const res = await graphSend(sim.url, w01('+966552222222'));
    await sim.client.pressButton({ to: '+966552222222' });
    await sim.client.emitStatuses({ wamid: res.json.messages[0].id, statuses: ['delivered'] });
    const [press, status] = await hook.waitFor(2);
    const v = value(press!);
    expect(v.contacts[0]).not.toHaveProperty('wa_id');
    expect(v.contacts[0].user_id).toMatch(/^SA\.\d{20}$/);
    expect(v.messages[0]).not.toHaveProperty('from');
    expect(v.messages[0].from_user_id).toBe(v.contacts[0].user_id);
    const s = value(status!).statuses[0];
    expect(s).not.toHaveProperty('recipient_id');
    expect(s.recipient_user_id).toBe(v.contacts[0].user_id);
  });

  it('can be switched off', async () => {
    await sim.client.configure({ deterministicFaults: false });
    expect((await graphSend(sim.url, w01('+966551111111'))).status).toBe(200);
  });

  it('session text to the business number itself is refused (131021)', async () => {
    const res = await graphSend(sim.url, sessionText('+966500000000', 'x'));
    expect(res.json.error.code).toBe(131021);
  });
});
