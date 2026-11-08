import { generateSecret, generateURI, verify } from 'otplib';

export const TOTP_PERIOD_S = 30;

/** RFC 6238 TOTP, 6 digits, 30 s, window ±1 step, replay protection via users.mfa_last_step (09 §9.1). */
export function newTotpSecret(): string {
  return generateSecret({ length: 20 }); // 160 bits, base32
}

export function totpUri(opts: { issuer: string; label: string; secret: string }): string {
  return generateURI({
    issuer: opts.issuer,
    label: opts.label,
    secret: opts.secret,
    digits: 6,
    period: TOTP_PERIOD_S,
  });
}

export async function verifyTotp(opts: {
  secret: string;
  token: string;
  now: Date;
  lastStep: number | null;
}): Promise<{ valid: false } | { valid: true; step: number }> {
  if (!/^[0-9]{6}$/.test(opts.token)) return { valid: false };
  const r = await verify({
    secret: opts.secret,
    token: opts.token,
    epoch: Math.floor(opts.now.getTime() / 1000),
    epochTolerance: TOTP_PERIOD_S,
    period: TOTP_PERIOD_S,
    digits: 6,
    ...(opts.lastStep != null ? { afterTimeStep: opts.lastStep } : {}),
  } as Parameters<typeof verify>[0]);
  if (!r.valid) return { valid: false };
  const step = (r as { timeStep?: number }).timeStep ?? Math.floor(opts.now.getTime() / 1000 / TOTP_PERIOD_S);
  return { valid: true, step };
}
