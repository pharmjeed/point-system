/**
 * Server clock (02 §1.7): countdowns use server time, never the device clock alone.
 * `offset = server_time − Date.now()` from the latest reply (`meta.server_time`);
 * remaining = `expires_at − (Date.now() + offset)`.
 */
let offsetMs = 0;
let lastServerTime: string | null = null;

export function recordServerTime(
  serverTimeIso: string | undefined | null,
  receivedAt: number = Date.now(),
): void {
  if (!serverTimeIso) return;
  const server = Date.parse(serverTimeIso);
  if (Number.isNaN(server)) return;
  offsetMs = server - receivedAt;
  lastServerTime = serverTimeIso;
}

export function serverNow(now: number = Date.now()): number {
  return now + offsetMs;
}

export function clockOffsetMs(): number {
  return offsetMs;
}

export function lastServerTimeIso(): string | null {
  return lastServerTime;
}

/** Seconds left until an ISO deadline, by server time (never negative). */
export function secondsUntil(deadlineIso: string, now: number = Date.now()): number {
  return Math.max(0, (Date.parse(deadlineIso) - serverNow(now)) / 1000);
}
