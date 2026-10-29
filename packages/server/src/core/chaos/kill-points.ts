import { writeSync } from 'node:fs';

/**
 * Kill points of 17 H-03 (PNT-098): the process dies on the spot — SIGKILL, what a container runtime reports as
 * exit code 137: no exit handlers, no response flushed, no transaction finished — at a named point, so the chaos
 * harness (infra/chaos) can prove AC-06 (TC-013 … TC-017) against the real api and worker processes.
 *
 * Inert unless `CHAOS_KILL_AT` names the point (a comma list is accepted), and never armed when
 * `APP_ENV=production` whatever the variable says; a production process refuses to boot with it anyway, and any
 * process refuses an unknown point name (`deploymentProblems`). One `Set.has` per call when unarmed.
 */
export const KILL_POINTS = [
  /** KP-1: after the `whatsapp_inbound_events` row committed, before the 200 of the webhook */
  'webhook_after_store_before_ack',
  /** KP-2: after the transaction of an inbound button message (the cycle) committed, before the event is `processed` */
  'inbound_after_cycle_commit',
  /** KP-3: after a `job.wa_send` outbox row was leased, before anything else (the provider call comes later) */
  'outbox_after_lock_before_send',
  /** KP-4: after the provider accepted the message, before `wa_message_id` and the outcome are recorded */
  'wa_send_after_provider_ok_before_done',
  /** KP-5: after the accept command committed, before its HTTP response is written */
  'accept_after_commit_before_response',
] as const;

export type KillPoint = (typeof KILL_POINTS)[number];

const KNOWN: ReadonlySet<string> = new Set(KILL_POINTS);

/** The names listed in a `CHAOS_KILL_AT` value (comma or space separated, empty entries ignored). */
export function parseKillPoints(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Names of a `CHAOS_KILL_AT` value that are not kill points of 17 H-03 (a typo must not leave a run unarmed). */
export function unknownKillPoints(value: string | undefined | null): string[] {
  return parseKillPoints(value).filter((n) => !KNOWN.has(n));
}

/** The armed points for an environment: none in production, else the known names of `CHAOS_KILL_AT`. */
export function armedKillPoints(env: Record<string, string | undefined> = process.env): Set<KillPoint> {
  if ((env.APP_ENV ?? '').trim().toLowerCase() === 'production') return new Set();
  return new Set(parseKillPoints(env.CHAOS_KILL_AT).filter((n): n is KillPoint => KNOWN.has(n)));
}

export type KillHandler = (point: KillPoint) => void;

/** The real crash: one line on stderr (synchronous, so it is not lost) for the harness, then SIGKILL. */
const sigkill: KillHandler = (point) => {
  try {
    writeSync(
      2,
      `${JSON.stringify({ level: 'fatal', msg: 'chaos kill point reached: SIGKILL', kill_point: point, pid: process.pid })}\n`,
    );
  } catch {
    // stderr closed: die anyway
  }
  process.kill(process.pid, 'SIGKILL');
};

let armed: Set<KillPoint> | null = null;
let handler: KillHandler = sigkill;

/** Stops the process here when `point` is armed; does nothing otherwise. */
export function killPoint(point: KillPoint): void {
  armed ??= armedKillPoints();
  if (armed.has(point)) handler(point);
}

/**
 * Test seam: re-reads the armed set from `env` (default process.env) and replaces the handler (default SIGKILL).
 * `resetKillPoints()` restores both.
 */
export function configureKillPoints(opts: {
  env?: Record<string, string | undefined>;
  handler?: KillHandler;
}) {
  armed = armedKillPoints(opts.env ?? process.env);
  handler = opts.handler ?? sigkill;
}

export function resetKillPoints(): void {
  armed = null;
  handler = sigkill;
}
