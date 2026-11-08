import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';
import {
  assertNotProduction,
  ConfigError,
  createSimulatorServer,
  optionsFromEnv,
  ProductionRefusedError,
  startSimulator,
} from '../src/index.js';

function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const io: CliIo = { log: (l) => out.push(l), error: (l) => err.push(l), exit: (c) => exits.push(c) };
  return { io, out, err, exits };
}

describe('production guard', () => {
  it.each([
    [{ NODE_ENV: 'production' }, 'NODE_ENV'],
    [{ APP_ENV: 'production' }, 'APP_ENV'],
    [{ APP_ENV: ' Production ', NODE_ENV: 'development' }, 'APP_ENV'],
  ])('refuses %o', async (env, key) => {
    expect(() => assertNotProduction(env)).toThrow(ProductionRefusedError);
    expect(() => assertNotProduction(env)).toThrow(`${key}=production`);
    expect(() => createSimulatorServer({ env })).toThrow(ProductionRefusedError);
    await expect(startSimulator({ env })).rejects.toThrow(ProductionRefusedError);
  });

  it('allows local, test and staging', () => {
    for (const env of [
      {},
      { NODE_ENV: 'test' },
      { APP_ENV: 'local' },
      { APP_ENV: 'staging', NODE_ENV: 'development' },
    ]) {
      expect(() => assertNotProduction(env)).not.toThrow();
    }
  });

  it('the CLI exits 1 with a clear message and never listens', async () => {
    const { io, err, exits, out } = fakeIo();
    const sim = await runCli({ APP_ENV: 'production', APP_SECRET: 'x', PORT: '0' }, io);
    expect(sim).toBeNull();
    expect(exits).toEqual([1]);
    expect(err.join('\n')).toMatch(/refuses to start: APP_ENV=production/);
    expect(out).toEqual([]);
  });
});

describe('CLI configuration', () => {
  it('exits 1 without APP_SECRET', async () => {
    const { io, err, exits } = fakeIo();
    expect(await runCli({ PORT: '0' }, io)).toBeNull();
    expect(exits).toEqual([1]);
    expect(err[0]).toContain('APP_SECRET is required');
  });

  it('rejects malformed values', () => {
    expect(() => optionsFromEnv({ APP_SECRET: 'x', PORT: 'abc' })).toThrow(ConfigError);
    expect(() => optionsFromEnv({ APP_SECRET: 'x', AUTO_STATUSES: 'maybe' })).toThrow(ConfigError);
    expect(() => optionsFromEnv({ APP_SECRET: 'x', STATUS_ORDER: 'sideways' })).toThrow(ConfigError);
    expect(() => optionsFromEnv({ APP_SECRET: 'x', WEBHOOK_URL: 'ftp://x' })).toThrow(ConfigError);
  });

  it('reads the ticket names, with the API WA_* names as fallbacks', () => {
    const o = optionsFromEnv({
      WA_APP_SECRET: 'secret',
      WEBHOOK_URL: 'http://localhost:3000/webhooks/whatsapp',
      WA_VERIFY_TOKEN: 'vt',
      PHONE_NUMBER_ID: '111',
      WA_PHONE_NUMBER_ID: '222',
      DISPLAY_PHONE_E164: '+966511111110',
      AUTO_STATUSES: 'false',
      STATUS_DELAY_MS: '10',
      STATUS_ORDER: 'reversed',
    });
    expect(o).toMatchObject({
      port: 4010,
      appSecret: 'secret',
      webhookUrl: 'http://localhost:3000/webhooks/whatsapp',
      verifyToken: 'vt',
      phoneNumberId: '111',
      displayPhoneE164: '+966511111110',
      autoStatuses: false,
      statusDelayMs: 10,
      statusOrder: 'reversed',
    });
  });

  it('starts, serves health and shuts down', async () => {
    const { io, out, exits } = fakeIo();
    const sim = await runCli({ APP_SECRET: 'x', PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'development' }, io);
    expect(sim).not.toBeNull();
    try {
      expect(out[0]).toMatch(/listening on 127\.0\.0\.1:\d+/);
      expect(await sim!.client.health()).toMatchObject({ ok: true, channel: 'up' });
      expect(exits).toEqual([]);
    } finally {
      await sim!.close();
    }
  });
});
