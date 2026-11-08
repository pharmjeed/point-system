import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KILL_POINTS,
  armedKillPoints,
  configureKillPoints,
  deploymentProblems,
  killPoint,
  loadEnv,
  parseKillPoints,
  resetKillPoints,
  unknownKillPoints,
  type KillPoint,
} from '../src/index.js';

/** PNT-098 / 17 H-03: kill points are inert unless CHAOS_KILL_AT names them, and never armed in production. */
describe('chaos kill points (17 H-03)', () => {
  afterEach(() => {
    resetKillPoints();
    vi.restoreAllMocks();
  });

  const recorder = () => {
    const hits: KillPoint[] = [];
    return { hits, handler: (p: KillPoint) => void hits.push(p) };
  };

  it('names the five points of H-03 in KP order', () => {
    expect(KILL_POINTS).toEqual([
      'webhook_after_store_before_ack',
      'inbound_after_cycle_commit',
      'outbox_after_lock_before_send',
      'wa_send_after_provider_ok_before_done',
      'accept_after_commit_before_response',
    ]);
  });

  it('is inert without CHAOS_KILL_AT', () => {
    const r = recorder();
    configureKillPoints({ env: {}, handler: r.handler });
    for (const p of KILL_POINTS) killPoint(p);
    expect(r.hits).toEqual([]);
  });

  it('fires only the armed point(s)', () => {
    const r = recorder();
    configureKillPoints({ env: { CHAOS_KILL_AT: 'inbound_after_cycle_commit' }, handler: r.handler });
    for (const p of KILL_POINTS) killPoint(p);
    expect(r.hits).toEqual(['inbound_after_cycle_commit']);

    const both = recorder();
    configureKillPoints({
      env: {
        APP_ENV: 'test',
        CHAOS_KILL_AT: ' outbox_after_lock_before_send , accept_after_commit_before_response',
      },
      handler: both.handler,
    });
    for (const p of KILL_POINTS) killPoint(p);
    expect(both.hits).toEqual(['outbox_after_lock_before_send', 'accept_after_commit_before_response']);
  });

  it('is never armed in production, whatever the variable says', () => {
    const r = recorder();
    configureKillPoints({
      env: { APP_ENV: 'production', CHAOS_KILL_AT: KILL_POINTS.join(',') },
      handler: r.handler,
    });
    for (const p of KILL_POINTS) killPoint(p);
    expect(r.hits).toEqual([]);
    expect(
      armedKillPoints({ APP_ENV: 'PRODUCTION', CHAOS_KILL_AT: 'webhook_after_store_before_ack' }).size,
    ).toBe(0);
    expect([
      ...armedKillPoints({ APP_ENV: 'staging', CHAOS_KILL_AT: 'webhook_after_store_before_ack' }),
    ]).toEqual(['webhook_after_store_before_ack']);
  });

  it('the real handler stops the process with SIGKILL (exit 137 under a container runtime)', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    configureKillPoints({ env: { CHAOS_KILL_AT: 'wa_send_after_provider_ok_before_done' } });
    killPoint('webhook_after_store_before_ack');
    expect(kill).not.toHaveBeenCalled();
    killPoint('wa_send_after_provider_ok_before_done');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
  });

  it('parses comma or space separated lists and reports unknown names', () => {
    expect(parseKillPoints('a, b  c,,')).toEqual(['a', 'b', 'c']);
    expect(parseKillPoints(undefined)).toEqual([]);
    expect(unknownKillPoints('webhook_after_store_before_ack,webhook_before_store')).toEqual([
      'webhook_before_store',
    ]);
  });

  it('the boot refuses CHAOS_KILL_AT in production and an unknown point anywhere else', () => {
    const base = {
      APP_BASE_URL: 'http://localhost:5173',
      BRAND_STAFF_NAME_AR: 'S',
      BRAND_STAFF_NAME_EN: 'S',
      BRAND_CUSTOMER_NAME_AR: 'C',
      BRAND_CUSTOMER_NAME_EN: 'C',
      DATABASE_URL: 'postgres://x@127.0.0.1:1/x',
      SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
      CODE_PEPPER: Buffer.alloc(32, 2).toString('base64'),
      AUTH_SECRET_PEPPER: Buffer.alloc(32, 3).toString('base64'),
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
      SESSION_COOKIE_NAME: 'point_sid',
      SESSION_COOKIE_SECURE: 'false',
      APP_ENV: 'test',
    };
    const problems = (o: Record<string, string>) => {
      const source = { ...base, ...o };
      return deploymentProblems(loadEnv(source), source);
    };
    expect(problems({ CHAOS_KILL_AT: 'accept_after_commit_before_response' })).toEqual([]);
    expect(problems({ CHAOS_KILL_AT: 'accept_after_commit, outbox_after_lock_before_send' })).toEqual([
      'CHAOS_KILL_AT names unknown kill points: accept_after_commit (17 H-03)',
    ]);
    expect(problems({ CHAOS_KILL_AT: '' })).toEqual([]);
  });
});
